#!/usr/bin/env node
// INTERACTIVE OPERATOR TOOL ONLY — never import/mount in a web server,
// run in CI, commit output, or pass the secret through ChatGPT.
// Staging-only. No production access and no user-selected browser grant.
import pg from 'pg';
import {randomBytes,createHash} from 'node:crypto';
import {createInterface} from 'node:readline/promises';
import {createTimeclockScannerIdentity} from '../services/scannerTimeclockIdentity.js';

const ID=/^[1-9][0-9]{0,17}$/;
const LABEL=/^[A-Za-z0-9_.:@-]{8,128}$/;
const refuse=()=>{throw Error('Owner activation operator prerequisites not met.');};
async function issue({
 env=process.env,now=()=>Date.now(),
 createPool=opts=>new pg.Pool(opts),createIdentity=createTimeclockScannerIdentity,
 random=randomBytes,confirm
}={}){
 // Recovery requires an EXPLICIT different flag and extra operator acknowledgement.
 // Neither path can run unattended, over HTTP, from CI, or with the runtime DB.
 const mode=process.argv.slice(2).join(' ');
 const recovery=mode==='--reissue-expired-staging-owner';
 if(!['--issue-staging-owner','--reissue-expired-staging-owner'].includes(mode)||
    !process.stdin.isTTY||!process.stdout.isTTY||typeof confirm!=='function'||
    (recovery&&env.HC_OWNER_OPERATOR_RECOVERY_ACK!==
      'I_REVIEWED_EXPIRED_UNUSED_ACTIVATION'))
  refuse();
 const id=String(env.HC_OWNER_TIMECLOCK_EMPLOYEE_ID??'');
 if(env.NODE_ENV!=='test'||env.HC_SECURITY_ENV!=='isolated-staging'||
    env.HC_OWNER_STAGING_ENABLED!=='true'||
    env.HC_OWNER_OPERATOR_ACK!=='I_VERIFIED_EMPLOYEE_ACCOUNT'||
    !ID.test(id)||id==='901'||!LABEL.test(env.HC_OWNER_OPERATOR_REF||''))
  refuse();
 let db;
 try{db=new URL(env.HC_OWNER_OPERATOR_DATABASE_URL);}catch{refuse();}
 if(!['postgres:','postgresql:'].includes(db.protocol)||
    db.pathname!=='/hc_owner_stage_test'||!db.username||
    env.HC_OWNER_OPERATOR_DATABASE_URL===env.HC_OWNER_STAGING_DATABASE_URL)
  refuse();
 const identity=createIdentity({
  baseUrl:env.HC_OWNER_TIMECLOCK_ORIGIN,
  serviceSecret:env.HC_OWNER_TIMECLOCK_SERVICE_SECRET,
  mode:'owner-staging'
 });
 const person=await identity.authorize(id);
 if(String(person?.id)!==id||person?.permissionSource!=='timeclock_employee'||
    person?.canLookup!==true)refuse();
 // The operator has independently reviewed the account and must also
 // confirm the exact canonical target shown locally before creating a grant.
 const agreed=await confirm({employeeId:id,employeeName:String(person.name||'')});
 if(agreed!==true)refuse();
 const secret=random(32);
 if(!Buffer.isBuffer(secret)||secret.length!==32)refuse();
 const digest=createHash('sha256').update(secret).digest('hex');
 const instant=now();
 if(!Number.isSafeInteger(instant)||instant<0)refuse();
 const pool=createPool({connectionString:db.toString(),max:1});
 let client;
 try{
  client=await pool.connect();
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(78619136,801)');
  const owners=await client.query('SELECT 1 FROM hc_admin_principals LIMIT 1');
  if(owners.rowCount!==0)refuse();
  const previous=await client.query(
   'SELECT employee_id FROM hc_first_owner_activations LIMIT 2');
  let expiresAt;
  if(!recovery){
   if(previous.rowCount!==0)refuse(); // Initial grant is strictly first-use.
   const row=await client.query(
    `INSERT INTO hc_first_owner_activations
       (employee_id,activation_digest,approved_at,expires_at,issued_by)
     VALUES($1,$2,$3,$4,$5) RETURNING employee_id`,
    [id,digest,new Date(instant).toISOString(),
     new Date(instant+10*60_000).toISOString(),env.HC_OWNER_OPERATOR_REF]
   );
   if(row.rowCount!==1)refuse();
   expiresAt=new Date(instant+10*60_000).toISOString();
  }else{
   // Recovery cannot be a manual UPDATE/DELETE. The separately approved,
   // operator-only, staging DB function checks expired+unused, zero Owners,
   // no existing credential, one reissue ever, and records immutable history.
   if(previous.rowCount!==1||String(previous.rows[0]?.employee_id)!==id)refuse();
   const result=await client.query(
    `SELECT public.hc_reissue_expired_first_owner_activation(
       $1::bigint,$2::text,$3::text) AS expires_at`,
    [id,digest,env.HC_OWNER_OPERATOR_REF]
   );
   if(result.rowCount!==1||!result.rows[0]?.expires_at)refuse();
   expiresAt=new Date(result.rows[0].expires_at).toISOString();
   if(!Number.isFinite(new Date(expiresAt).getTime()))refuse();
  }
  await client.query('COMMIT');
  return Object.freeze({employeeId:id,activationSecret:secret.toString('base64url'),
   expiresAt});
 }catch(error){
  if(client)await client.query('ROLLBACK').catch(()=>{});
  refuse();
 }finally{client?.release();await pool.end();}
}
if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href){
 const cli=createInterface({input:process.stdin,output:process.stdout});
 try{
  const result=await issue({confirm:async({employeeId,employeeName})=>{
   const answer=await cli.question(
    'Verify canonical Timeclock employee '+employeeId+' ('+
     employeeName.replace(/[\r\n\x00-\x1f]/g,'').slice(0,80)+
     '). Type the exact employee ID to approve: '
   );
   return answer===employeeId;
  }});
  process.stdout.write('PRIVATE one-time staging activation (expires '+
   result.expiresAt+'): '+result.activationSecret+'\n');
  process.stdout.write('Do not save, log, or send this activation code in chat.\n');
 }catch{
  console.error('Owner staging activation was NOT issued.');
  process.exitCode=1;
 }finally{cli.close();}
}
