import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {createOperatorFirstOwnerPasskeyCandidate}
 from '../services/security/operatorFirstOwnerPasskeyCandidate.js';

const database=process.env.HC_TEST_DATABASE_URL;
const gated={skip:!database?'Disposable PostgreSQL required':false};
test('operator-controlled exact employee activation atomically registers first Owner, not a PIN',gated,async()=>{
 if(!/hc_test/.test(database))throw Error('Refusing non-disposable database');
 const adminPool=new pg.Pool({connectionString:database,max:2});
 const schema='hc_operator_owner_'+process.pid;
 let pool;
 const owner='42',token=randomBytes(32).toString('base64url'),
       wrongToken=randomBytes(32).toString('base64url');
 const credentialId=randomBytes(32).toString('base64url');
 const session={employeeId:'42',activation:token};
 const now=()=>Date.now();
 const fixture={
   generateRegistrationOptions:async()=>({challenge:randomBytes(32).toString('base64url')}),
   verifyRegistrationResponse:async()=>({verified:true,registrationInfo:{
     credential:{id:credentialId,publicKey:new Uint8Array(32),counter:0,transports:['internal']},
     credentialDeviceType:'multiDevice',credentialBackedUp:true
   }}),
   generateAuthenticationOptions:async()=>({challenge:'unused'}),
   verifyAuthenticationResponse:async()=>({verified:false})
 };
 try{
  await adminPool.query('CREATE SCHEMA '+schema);
  pool=new pg.Pool({connectionString:database,max:3,options:'-c search_path='+schema});
  for(const name of ['hc_staff_passkeys.sql','hc_admin_delegations.sql','hc_first_owner_operator_activation.sql']){
   await pool.query(await readFile(new URL('../db/'+name,import.meta.url),'utf8'));
  }
  const candidate=createOperatorFirstOwnerPasskeyCandidate({
    environment:'test',enabled:true,expectedOwnerEmployeeId:owner,
    pool,origin:'http://localhost',rpID:'localhost',
    signingSecret:'test-only-operator-bootstrap-signing-secret-12345678',
    now,loginThrottle:{reserve:async()=>true},webauthn:fixture,
    staffAuthGateway:{verifyBoundEmployee:async context=>{
      if(!context?.employeeId)throw Error('No signed employee');
      return {id:context.employeeId,employeeId:context.employeeId,active:true,
        binding:'signed-test-only-canonical-session-12345678',
        expiresAtMs:Date.now()+60000};
    }},
    timeclockIdentity:{authorize:async id=>({
      id,permissionSource:'timeclock_employee',canLookup:true
    })},
    readActivationSecret:async context=>context?.activation
  });
  const denied=e=>e?.status===403;
  await assert.rejects(candidate.beginRegistration({context:session}),denied,
    'PIN/session alone is never sufficient without operator authorization');
  const t=Date.now();
  await pool.query(
    `INSERT INTO hc_first_owner_activations
      (employee_id,activation_digest,approved_at,expires_at,issued_by)
      VALUES($1,$2,$3,$4,$5)`,
    [owner,createHash('sha256').update(token).digest('hex'),
     new Date(t-3000),new Date(t+120000),'deployment-operator']
  );
  await assert.rejects(candidate.beginRegistration({
    context:{employeeId:owner,activation:wrongToken}
  }),denied);
  await assert.rejects(candidate.beginRegistration({
    context:{employeeId:'43',activation:token}
  }),denied,'a different active employee cannot take Owner');
  // Prove audit failure rolls back existing passkey insert, approval
  // consumption, and role appointment in one transaction.
  await pool.query(`CREATE FUNCTION fail_bootstrap_audit() RETURNS trigger
    LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''test audit failure''; END;'`);
  await pool.query(`CREATE TRIGGER owner_fail_audit BEFORE INSERT
    ON hc_first_owner_activation_events
    FOR EACH ROW EXECUTE FUNCTION fail_bootstrap_audit()`);
  const first=await candidate.beginRegistration({context:session});
  await assert.rejects(candidate.finishRegistration({
    context:session,challengeId:first.challengeId,response:{id:credentialId}
  }),e=>e?.status===503);
  for(const table of ['hc_admin_principals','hc_staff_passkeys','hc_first_owner_activation_events']){
    const count=await pool.query('SELECT count(*)::integer AS n FROM '+table);
    assert.equal(count.rows[0].n,0,'rollback leaves no '+table);
  }
  assert.equal((await pool.query(
    'SELECT consumed_at FROM hc_first_owner_activations WHERE employee_id=$1',[owner]
  )).rows[0].consumed_at,null);
  await pool.query('DROP TRIGGER owner_fail_audit ON hc_first_owner_activation_events');
  await pool.query('DROP FUNCTION fail_bootstrap_audit()');
  await assert.rejects(candidate.finishRegistration({
    context:session,challengeId:first.challengeId,response:{id:credentialId}
  }),denied,'old challenge cannot replay');
  const second=await candidate.beginRegistration({context:session});
  assert.deepEqual(await candidate.finishRegistration({
    context:session,challengeId:second.challengeId,response:{id:credentialId}
  }),{registered:true});
  assert.equal((await pool.query("SELECT role FROM hc_admin_principals WHERE employee_id=$1",[owner])).rows[0].role,'owner');
  assert.equal((await pool.query('SELECT count(*)::integer AS n FROM hc_first_owner_activation_events')).rows[0].n,1);
  await assert.rejects(candidate.beginRegistration({context:session}),denied);
  await assert.rejects(pool.query('DELETE FROM hc_first_owner_activation_events'),/append-only/);
 }finally{
  if(pool)await pool.end();
  await adminPool.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE').catch(()=>{});
  await adminPool.end();
 }
});
test('operator bootstrap cannot turn on without explicit isolated test configuration',()=>{
 assert.throws(()=>createOperatorFirstOwnerPasskeyCandidate(),TypeError);
 assert.throws(()=>createOperatorFirstOwnerPasskeyCandidate({
   environment:'production',enabled:true,expectedOwnerEmployeeId:'42'
 }),TypeError);
});
