import {createHmac,createHash,randomUUID,randomBytes,timingSafeEqual} from 'node:crypto';
import * as officialWebAuthn from '@simplewebauthn/server';

// UNMOUNTED candidate. Neither a 4-digit PIN nor a browser role is permission
// to register a passkey. Initial enrollment requires separate owner-approved
// bootstrap; subsequent grants require independently verified manager MFA.
const ID=/^[1-9][0-9]{0,17}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BIND=/^[A-Za-z0-9_.:-]{16,256}$/;
const B64=/^[A-Za-z0-9_-]+$/;
const denied=()=>Object.assign(new Error('Verified passkey required.'),{status:403,code:'HC_PASSKEY_DENIED'});
const unavailable=()=>Object.assign(new Error('Passkey service unavailable.'),{status:503,code:'HC_PASSKEY_UNAVAILABLE'});

export function createPostgresStaffPasskeys({
 pool,origin,rpID,signingSecret,verifyBoundEmployee,authorizeRegistration,
 verifyStrongManager,canManage,loginThrottle,commitRegistrationGrant=null,now=()=>Date.now(),
 webauthn=officialWebAuthn
}={}){
 if(typeof pool?.connect!=='function'||typeof signingSecret!=='string'||
    Buffer.byteLength(signingSecret)<32||
    [verifyBoundEmployee,authorizeRegistration,verifyStrongManager,canManage,now]
      .some(f=>typeof f!=='function')||
    typeof loginThrottle?.reserve!=='function'||
    (commitRegistrationGrant!==null&&typeof commitRegistrationGrant!=='function')||
    ['generateRegistrationOptions','verifyRegistrationResponse',
      'generateAuthenticationOptions','verifyAuthenticationResponse']
      .some(key=>typeof webauthn?.[key]!=='function'))
   throw new TypeError('Trusted session, approved enrollment, WebAuthn verifier and persistent storage required.');
 let site;
 try{site=new URL(origin);}catch{throw new TypeError('Exact WebAuthn site origin required.');}
 if(typeof rpID!=='string'||!rpID||rpID!==rpID.toLowerCase()||
    !/^[a-z0-9.-]+$/.test(rpID)||rpID.startsWith('.')||rpID.endsWith('.')||
    site.username||site.password||site.pathname!=='/'||site.search||site.hash||
    !['https:','http:'].includes(site.protocol)||
    (site.protocol==='http:'&&site.hostname!=='localhost')||
    !(site.hostname===rpID||site.hostname.endsWith('.'+rpID))||
    site.origin!==origin)
   throw new TypeError('Use an exact HTTPS origin and matching RP ID, or localhost for isolated tests.');
 const mac=v=>createHmac('sha256',signingSecret).update(v).digest('base64url');
 const sessionHash=v=>createHmac('sha256',signingSecret)
    .update('hc:passkey:staff-session:v1:'+v).digest('hex');
 const stamp=()=>{const t=now();if(!Number.isSafeInteger(t)||t<0)throw unavailable();return t;};
 const iso=ms=>new Date(ms).toISOString();
 async function tx(work){
   let c;
   try{c=await pool.connect();await c.query('BEGIN');
     const result=await work(c);await c.query('COMMIT');return result;
   }catch(e){
     if(c)await c.query('ROLLBACK').catch(()=>{});
     if(e?.code==='HC_PASSKEY_DENIED')throw e;
     throw unavailable();
   }finally{c?.release();}
 }
 async function employee(context){
   let value;
   try{value=await verifyBoundEmployee(context);}catch{throw denied();}
   const t=stamp(),id=String(value?.employeeId||value?.id||'');
   if(value?.active!==true||!ID.test(id)||typeof value.binding!=='string'||
      !BIND.test(value.binding)||!Number.isSafeInteger(value.expiresAtMs)||
      value.expiresAtMs<=t)throw denied();
   return {id,sid:sessionHash(value.binding)};
 }
 async function throttle(employeeId,sourceIp){
   let allowed=false;
   try{allowed=await loginThrottle.reserve({employeeId,sourceIp})===true;}
   catch{throw unavailable();}
   if(!allowed)throw denied();
 }
 async function registrationApproval(context,employeeId,phase){
   let accepted=false;
   try{accepted=await authorizeRegistration({context,employeeId,phase})===true;}
   catch{/* do not fall back to PIN */}
   if(!accepted)throw denied();
 }
 async function newChallenge(person,purpose,challenge){
   const challengeId=randomUUID();
   await tx(c=>c.query(
     'INSERT INTO hc_staff_passkey_challenges(challenge_id,employee_id,session_hash,purpose,challenge,expires_at) VALUES($1,$2,$3,$4,$5,$6)',
     [challengeId,person.id,person.sid,purpose,challenge,iso(stamp()+90000)]
   ));
   return challengeId;
 }
 // Consume BEFORE verifying the authenticator; invalid/replayed responses
 // never get another attempt. DB row lock makes this replica-safe.
 async function consume(person,challengeId,purpose){
   if(!UUID.test(String(challengeId||'')))throw denied();
   const t=stamp();
   return tx(async c=>{
     const got=await c.query(
       'SELECT employee_id,session_hash,purpose,challenge,expires_at,consumed_at FROM hc_staff_passkey_challenges WHERE challenge_id=$1 FOR UPDATE',
       [challengeId]);
     const row=got.rows?.[0];
     if(!row||row.consumed_at||String(row.employee_id)!==person.id||
       row.session_hash!==person.sid||row.purpose!==purpose||
       new Date(row.expires_at).getTime()<=t)throw denied();
     await c.query(
       'UPDATE hc_staff_passkey_challenges SET consumed_at=now() WHERE challenge_id=$1',[challengeId]);
     return String(row.challenge);
   });
 }
 async function credentials(id){
   return tx(async c=>{
     const rows=await c.query(
       'SELECT credential_id,public_key,counter,transports,generation FROM hc_staff_passkeys WHERE employee_id=$1 AND revoked_at IS NULL',
       [id]);
     return rows.rows;
   });
 }
 async function beginRegistration({context,sourceIp}={}){
   const person=await employee(context);
   await throttle(person.id,sourceIp);
   await registrationApproval(context,person.id,'begin');
   const existing=await credentials(person.id);
   const options=await webauthn.generateRegistrationOptions({
     rpID,rpName:'Hobby Corner',
     userName:'Hobby Corner employee '+person.id,
     userDisplayName:'Hobby Corner staff',
     userID:new Uint8Array(createHash('sha256').update('hc:passkey:user:'+person.id).digest()),
     attestationType:'none',
     authenticatorSelection:{residentKey:'preferred',userVerification:'required'},
     supportedAlgorithmIDs:[-7,-257],
     excludeCredentials:existing.map(r=>({id:r.credential_id,transports:r.transports||[]}))
   });
   if(!options?.challenge||typeof options.challenge!=='string')throw unavailable();
   const challengeId=await newChallenge(person,'register',options.challenge);
   return Object.freeze({challengeId,options});
 }
 async function finishRegistration({context,challengeId,response}={}){
   const person=await employee(context);
   const challenge=await consume(person,challengeId,'register');
   // A pending challenge alone is NEVER an enrollment authorization.
   await registrationApproval(context,person.id,'complete');
   if(!response||typeof response!=='object'||typeof response.id!=='string')throw denied();
   let check;
   try{check=await webauthn.verifyRegistrationResponse({
     response,expectedChallenge:challenge,expectedOrigin:origin,expectedRPID:rpID,
     requireUserVerification:true,supportedAlgorithmIDs:[-7,-257]
   });}catch{throw denied();}
   const cred=check?.registrationInfo?.credential;
   if(check?.verified!==true||!cred||
      cred.id!==response.id||!B64.test(cred.id)||cred.id.length>1024||
      !(cred.publicKey instanceof Uint8Array)||cred.publicKey.length<24||
      cred.publicKey.length>2048||!Number.isSafeInteger(cred.counter)||
      cred.counter<0)throw denied();
   const transports=Array.isArray(cred.transports)
     ?cred.transports.filter(s=>typeof s==='string'&&s.length<=32).slice(0,12):[];
   await tx(async c=>{
     await c.query(
       'INSERT INTO hc_staff_passkeys(credential_id,employee_id,public_key,counter,transports,device_type,backed_up) VALUES($1,$2,$3,$4,$5,$6,$7)',
       [cred.id,person.id,Buffer.from(cred.publicKey),cred.counter,transports,
        String(check.registrationInfo.credentialDeviceType||'unknown'),
        check.registrationInfo.credentialBackedUp===true]
     );
     await c.query(
       "INSERT INTO hc_staff_passkey_events(event_id,credential_id,employee_id,kind) VALUES($1,$2,$3,'registered')",
       [randomUUID(),cred.id,person.id]
     );
     // Optional staging-only one-use bootstrap grant must commit atomically
     // with the first verified credential. A rejected grant rolls back both
     // the credential and append-only event; PIN or Discord ownership alone
     // cannot create a registered manager credential.
     if(commitRegistrationGrant!==null)await commitRegistrationGrant({
       context,employeeId:person.id,credentialId:cred.id,client:c
     });
   });
   return Object.freeze({registered:true});
 }
 async function beginAuthentication({context,sourceIp}={}){
   const person=await employee(context);
   await throttle(person.id,sourceIp);
   const rows=await credentials(person.id);
   if(!rows.length)throw denied();
   const options=await webauthn.generateAuthenticationOptions({
     rpID,userVerification:'required',
     allowCredentials:rows.map(r=>({id:r.credential_id,transports:r.transports||[]}))
   });
   if(!options?.challenge||typeof options.challenge!=='string')throw unavailable();
   const challengeId=await newChallenge(person,'authenticate',options.challenge);
   return Object.freeze({challengeId,options});
 }
 async function finishAuthentication({context,challengeId,response}={}){
   const person=await employee(context);
   const challenge=await consume(person,challengeId,'authenticate');
   if(typeof response?.id!=='string'||!B64.test(response.id)||
     response.id.length>1024)throw denied();
   const rows=await credentials(person.id);
   const found=rows.find(r=>r.credential_id===response.id);
   if(!found)throw denied();
   let result;
   try{result=await webauthn.verifyAuthenticationResponse({
     response,expectedChallenge:challenge,expectedOrigin:origin,expectedRPID:rpID,
     requireUserVerification:true,
     credential:{
       id:found.credential_id,publicKey:new Uint8Array(found.public_key),
       counter:Number(found.counter),transports:found.transports||[]
     }
   });}catch{throw denied();}
   const counter=result?.authenticationInfo?.newCounter;
   if(result?.verified!==true||!Number.isSafeInteger(counter)||counter<0||
     counter<Number(found.counter))throw denied();
   // Optimistic lock serializes counter advancement across replicas and
   // checks the authenticator was not revoked during verification.
   await tx(async c=>{
     const updated=await c.query(
       'UPDATE hc_staff_passkeys SET counter=$3 WHERE credential_id=$1 AND employee_id=$2 AND counter=$4 AND generation=$5 AND revoked_at IS NULL RETURNING credential_id',
       [found.credential_id,person.id,counter,found.counter,found.generation]
     );
     if(updated.rowCount!==1)throw denied();
   });
   const time=stamp(),iat=Math.floor(time/1000);
   const body=Buffer.from(JSON.stringify({
     v:1,aud:'hc:staff:passkey',sub:person.id,sid:person.sid,
     cid:found.credential_id,gen:String(found.generation),authTime:time,
     iat,exp:iat+300,jti:randomBytes(16).toString('hex')
   })).toString('base64url');
   return Object.freeze({token:body+'.'+mac(body),expiresIn:300});
 }
 async function verify({context,token}={}){
   const person=await employee(context);
   if(typeof token!=='string'||token.length>2500||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token))throw denied();
   const [body,sig]=token.split('.'),expected=mac(body);
   if(sig.length!==expected.length||
      !timingSafeEqual(Buffer.from(sig),Buffer.from(expected)))throw denied();
   let c;
   try{c=JSON.parse(Buffer.from(body,'base64url').toString('utf8'));}catch{throw denied();}
   const t=stamp(),sec=Math.floor(t/1000);
   if(c?.v!==1||c.aud!=='hc:staff:passkey'||c.sub!==person.id||
      c.sid!==person.sid||typeof c.cid!=='string'||!B64.test(c.cid)||
      !UUID.test(String(c.gen||''))||!Number.isSafeInteger(c.iat)||
      c.iat>sec||!Number.isSafeInteger(c.exp)||c.exp<=sec||
      c.exp!==c.iat+300||!Number.isSafeInteger(c.authTime)||
      c.authTime>t||c.authTime<=t-300000||
      !/^[a-f0-9]{32}$/.test(String(c.jti||'')))throw denied();
   const good=await tx(async client=>{
     const res=await client.query(
       'SELECT 1 FROM hc_staff_passkeys WHERE credential_id=$1 AND employee_id=$2 AND generation=$3 AND revoked_at IS NULL',
       [c.cid,person.id,c.gen]);
     return res.rowCount===1;
   });
   if(!good)throw denied();
   return Object.freeze({
     verified:true,id:person.id,employeeId:person.id,active:true,
     method:'passkey',authenticatedAtMs:c.authTime
   });
 }
 async function verifyStrongManager(context){
   const token=typeof context?.get==='function'?context.get('x-hc-passkey-proof'):null;
   return verify({context,token});
 }
 async function verifyStepUp(context,identity){
   try{
     const proof=await verifyStrongManager(context);
     if(proof.employeeId!==String(identity?.id))return null;
     return proof;
   }catch{return null;}
 }
 async function revoke({context,credentialId}={}){
   if(typeof credentialId!=='string'||!B64.test(credentialId)||
      credentialId.length>1024)throw denied();
   const manager=await verifyStrongManager(context);
   let permission=false;
   try{permission=await canManage({
     context,approverId:manager.id,credentialId,operation:'staff.passkey.revoke'
   })===true;}catch{/* denied */}
   if(!permission)throw denied();
   return tx(async c=>{
     const r=await c.query(
       'UPDATE hc_staff_passkeys SET revoked_at=now(),generation=gen_random_uuid() WHERE credential_id=$1 AND revoked_at IS NULL RETURNING employee_id',
       [credentialId]);
     if(r.rowCount!==1)throw denied();
     await c.query(
       "INSERT INTO hc_staff_passkey_events(event_id,credential_id,employee_id,approver_id,kind) VALUES($1,$2,$3,$4,'revoked')",
       [randomUUID(),credentialId,String(r.rows[0].employee_id),manager.id]
     );
     return Object.freeze({revoked:true});
   });
 }
 return Object.freeze({beginRegistration,finishRegistration,beginAuthentication,
   finishAuthentication,verify,verifyStrongManager,verifyStepUp,revoke});
}
