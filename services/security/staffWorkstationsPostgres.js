import {createHmac,createPublicKey,randomBytes,randomUUID,timingSafeEqual,verify as checkSignature} from 'node:crypto';

// UNMOUNTED backend candidate. Every device supplies its unique Ed25519 public
// key through a separately authorized, strongly authenticated administrator.
// Never trust extension ID, Origin, IP, headers or a four-digit PIN as proof.
const ID=/^[1-9][0-9]{0,17}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BIND=/^[A-Za-z0-9_.:-]{16,256}$/;
const STRONG=new Set(['passkey','security-key','oidc-mfa']);
const deny=()=>Object.assign(new Error('Workstation verification denied.'),{status:403,code:'HC_STATION_DENIED'});
const unavailable=()=>Object.assign(new Error('Workstation security unavailable.'),{status:503,code:'HC_STATION_UNAVAILABLE'});
const b64=value=>typeof value==='string'&&/^[A-Za-z0-9_-]+$/.test(value);

export function createPostgresStaffWorkstations({
 pool,signingSecret,verifyEmployeeSession,verifyStrongManager,canManage,loginThrottle,
 now=()=>Date.now()
}={}){
 if(typeof pool?.connect!=='function'||typeof signingSecret!=='string'||
    Buffer.byteLength(signingSecret)<32||
    [verifyEmployeeSession,verifyStrongManager,canManage,now].some(f=>typeof f!=='function')||
    typeof loginThrottle?.reserve!=='function')
   throw new TypeError('Trusted staff sessions, manager MFA, audit store, throttle and signing key required.');
 const hmac=v=>createHmac('sha256',signingSecret).update(v).digest('base64url');
 const timestamp=()=>{const t=now();if(!Number.isSafeInteger(t)||t<0)throw unavailable();return t;};
 const sid=binding=>hmac('hc:station:session:v1:'+binding);
 const iso=ms=>new Date(ms).toISOString();
 async function tx(fn){
   let c;
   try{c=await pool.connect();await c.query('BEGIN');
     const result=await fn(c);await c.query('COMMIT');return result;
   }catch(e){
     if(c)await c.query('ROLLBACK').catch(()=>{});
     if(e?.code==='HC_STATION_DENIED')throw e;
     throw unavailable();
   }finally{c?.release();}
 }
 async function staff(context){
   let s;try{s=await verifyEmployeeSession(context);}catch{throw deny();}
   const t=timestamp();
   const id=String(s?.employeeId||s?.id||'');
   if(s?.active!==true||!ID.test(id)||typeof s.binding!=='string'||
      !BIND.test(s.binding)||!Number.isSafeInteger(s.expiresAtMs)||
      s.expiresAtMs<=t)throw deny();
   return {id,sid:sid(s.binding)};
 }
 async function manager(context,operation,deviceId=null){
   let proof,grant=false;
   try{
     proof=await verifyStrongManager(context);
     const t=timestamp();
     if(proof?.active!==true||!ID.test(String(proof.id||''))||
        !STRONG.has(proof.method)||!Number.isSafeInteger(proof.authenticatedAtMs)||
        proof.authenticatedAtMs>t||proof.authenticatedAtMs<=t-300000)throw deny();
     grant=await canManage({context,approverId:String(proof.id),operation,deviceId})===true;
   }catch{throw deny();}
   if(!grant)throw deny();
   return String(proof.id);
 }
 function spki(value){
   if(!b64(value)||value.length>128)throw deny();
   try{
     const raw=Buffer.from(value,'base64url');
     const key=createPublicKey({key:raw,format:'der',type:'spki'});
     if(key.asymmetricKeyType!=='ed25519'||raw.length!==44||
        key.export({format:'der',type:'spki'}).toString('base64url')!==value)throw deny();
     return raw;
   }catch{throw deny();}
 }
 async function register({context,publicKeySpki,label}={}){
   const managerId=await manager(context,'staff.workstation.register');
   const key=spki(publicKeySpki);
   const name=typeof label==='string'?label.trim():'';
   if(!name||name.length>80||/[^ -~]/.test(name))throw deny();
   const deviceId=randomUUID();
   return tx(async c=>{
     await c.query("INSERT INTO hc_staff_stations(device_id,public_key_spki,label,registered_by) VALUES($1,$2,$3,$4)",
       [deviceId,key,name,managerId]);
     await c.query("INSERT INTO hc_staff_station_events(event_id,device_id,actor_id,kind) VALUES($1,$2,$3,'registered')",
       [randomUUID(),deviceId,managerId]);
     return Object.freeze({deviceId,registered:true});
   });
 }
 async function beginChallenge({context,deviceId,sourceIp}={}){
   const employee=await staff(context);
   if(!UUID.test(String(deviceId||'')))throw deny();
   let accepted=false;
   try{accepted=await loginThrottle.reserve({employeeId:employee.id,sourceIp})===true;}
   catch{throw unavailable();}
   if(!accepted)throw deny();
   const t=timestamp(),challenge=randomBytes(32),challengeId=randomUUID();
   await tx(async c=>{
     const device=await c.query("SELECT 1 FROM hc_staff_stations WHERE device_id=$1 AND revoked_at IS NULL",
       [deviceId]);
     if(device.rowCount!==1)throw deny();
     await c.query(
       "INSERT INTO hc_staff_station_challenges(challenge_id,device_id,employee_id,session_hash,challenge,expires_at) VALUES($1,$2,$3,$4,$5,$6)",
       [challengeId,deviceId,employee.id,employee.sid,challenge,iso(t+90000)]
     );
   });
   return Object.freeze({challengeId,challenge:challenge.toString('base64url'),expiresAtMs:t+90000});
 }
 async function completeChallenge({context,challengeId,signature}={}){
   const employee=await staff(context);
   if(!UUID.test(String(challengeId||''))||!b64(signature)||signature.length>120)throw deny();
   const t=timestamp();
   const proof=await tx(async c=>{
     const got=await c.query(
       "SELECT c.device_id,c.employee_id,c.session_hash,c.challenge,c.expires_at,c.state,s.public_key_spki,s.generation,s.revoked_at "+
       "FROM hc_staff_station_challenges c JOIN hc_staff_stations s ON s.device_id=c.device_id "+
       "WHERE c.challenge_id=$1 FOR UPDATE OF c",[challengeId]
     );
     const record=got.rows?.[0];
     if(!record||record.state!=='issued')throw deny();
     // Every well-formed attempt consumes the challenge, even a bad signature.
     await c.query("UPDATE hc_staff_station_challenges SET state='consumed',consumed_at=now() WHERE challenge_id=$1",[challengeId]);
     let valid=false;
     try{
       const message=Buffer.from('hc:staff:station:v1:'+challengeId+':'+record.challenge.toString('base64url'));
       valid=record.revoked_at===null&&String(record.employee_id)===employee.id&&
         record.session_hash===employee.sid&&new Date(record.expires_at).getTime()>t&&
         checkSignature(null,message,
           createPublicKey({key:record.public_key_spki,format:'der',type:'spki'}),
           Buffer.from(signature,'base64url'));
     }catch{/* consumed invalid challenge */}
     return valid?{deviceId:String(record.device_id),generation:String(record.generation)}:null;
   });
   if(!proof)throw deny();
   const iat=Math.floor(t/1000);
   const body=Buffer.from(JSON.stringify({v:1,purpose:'hc:staff:station',
     sub:employee.id,sid:employee.sid,did:proof.deviceId,dg:proof.generation,
     iat,exp:iat+300,jti:randomBytes(16).toString('hex')})).toString('base64url');
   return Object.freeze({token:body+'.'+hmac(body),expiresIn:300});
 }
 async function verify({context,token}={}){
   const employee=await staff(context);
   if(typeof token!=='string'||token.length>1400||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token))throw deny();
   const [body,signature]=token.split('.'),expected=hmac(body);
   if(signature.length!==expected.length||
      !timingSafeEqual(Buffer.from(signature),Buffer.from(expected)))throw deny();
   let c;try{c=JSON.parse(Buffer.from(body,'base64url').toString('utf8'));}catch{throw deny();}
   const t=Math.floor(timestamp()/1000);
   if(c?.v!==1||c.purpose!=='hc:staff:station'||c.sub!==employee.id||
      c.sid!==employee.sid||!UUID.test(String(c.did||''))||!UUID.test(String(c.dg||''))||
      !Number.isSafeInteger(c.iat)||c.iat>t||
      !Number.isSafeInteger(c.exp)||c.exp<=t||c.exp!==c.iat+300||
      !/^[a-f0-9]{32}$/.test(String(c.jti||'')))throw deny();
   return tx(async client=>{
     const found=await client.query(
       "SELECT generation FROM hc_staff_stations WHERE device_id=$1 AND revoked_at IS NULL",[c.did]);
     if(found.rowCount!==1||String(found.rows[0].generation)!==c.dg)throw deny();
     return Object.freeze({verified:true,deviceId:c.did,employeeId:employee.id,
       expiresAtMs:c.exp*1000});
   });
 }
 async function verifyWorkstation(request,employee){
   try{
     const token=typeof request?.get==='function'?request.get('x-hc-station-proof'):null;
     if(!token)return null;
     const proof=await verify({context:request,token});
     return proof.employeeId===String(employee?.id)?proof:null;
   }catch{return null;}
 }
 async function revoke({context,deviceId}={}){
   if(!UUID.test(String(deviceId||'')))throw deny();
   const managerId=await manager(context,'staff.workstation.revoke',deviceId);
   return tx(async c=>{
     const result=await c.query(
       "UPDATE hc_staff_stations SET revoked_at=now(),generation=gen_random_uuid() "+
       "WHERE device_id=$1 AND revoked_at IS NULL RETURNING device_id",[deviceId]);
     if(result.rowCount!==1)throw deny();
     await c.query(
       "INSERT INTO hc_staff_station_events(event_id,device_id,actor_id,kind) VALUES($1,$2,$3,'revoked')",
       [randomUUID(),deviceId,managerId]);
     return Object.freeze({revoked:true});
   });
 }
 return Object.freeze({register,beginChallenge,completeChallenge,verify,verifyWorkstation,revoke});
}
