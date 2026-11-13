import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import pg from 'pg';

const sql=new URL('../db/hc_owner_stage_expired_activation_recovery.sql',import.meta.url);
const script=new URL('../scripts/issue-owner-stage-activation.mjs',import.meta.url);
const digest=()=>createHash('sha256').update(randomBytes(32)).digest('hex');

test('expired Owner recovery remains private, reviewed and non-destructive',async()=>{
 const [migration,cli]=await Promise.all([readFile(sql,'utf8'),readFile(script,'utf8')]);
 assert.match(migration,/current_database\(\) <> 'hc_owner_stage_test'/);
 assert.match(migration,/SECURITY DEFINER/);
 assert.match(migration,/pg_advisory_xact_lock\(78619136, 801\)/);
 assert.match(migration,/hc_first_owner_activation_reissues/);
 assert.match(migration,/FOR EACH STATEMENT EXECUTE FUNCTION/);
 assert.match(migration,/REVOKE ALL ON FUNCTION/);
 assert.match(migration,/GRANT EXECUTE ON FUNCTION[\s\S]*hc_owner_stage_operator_privs/);
 assert.doesNotMatch(migration,/GRANT (?:EXECUTE|UPDATE) [^;]* TO hc_owner_stage_runtime_privs/i);
 assert.match(cli,/--reissue-expired-staging-owner/);
 assert.match(cli,/I_REVIEWED_EXPIRED_UNUSED_ACTIVATION/);
 assert.match(cli,/hc_reissue_expired_first_owner_activation/);
 assert.match(cli,/process\.stdin\.isTTY/);
 assert.match(cli,/process\.stdout\.isTTY/);
 assert.doesNotMatch(cli,/DELETE FROM hc_first_owner_activations|TRUNCATE hc_first_owner_activations/);
 const attempt=spawnSync(process.execPath,[script.pathname,'--reissue-expired-staging-owner'],{
  encoding:'utf8',timeout:10000,env:{...process.env,HC_OWNER_OPERATOR_RECOVERY_ACK:'I_REVIEWED_EXPIRED_UNUSED_ACTIVATION'}
 });
 assert.notEqual(attempt.status,0,'non-interactive issuance must fail before network/database access');
 assert.match(attempt.stderr,/Owner staging activation was NOT issued/);
 assert.doesNotMatch(attempt.stdout,/PRIVATE one-time staging activation/);
});

// Requires a deliberately created throwaway PostgreSQL server on localhost,
// and an admin hc_test database. Refuses any staging/production Railway URL,
// any pre-existing hc_owner_stage_test database, or existing global roles.
const database=process.env.HC_TEST_DATABASE_URL;
const enabled=process.env.HC_OWNER_RECOVERY_DB_TEST==='1';
test('one expired unused activation can be reissued with immutable audit, never twice',
 {skip:enabled&&database?false:'Explicit disposable PostgreSQL required'},async()=>{
 const url=new URL(database);
 if(url.pathname!=='/hc_test'||!['localhost','127.0.0.1','::1'].includes(url.hostname))
  throw Error('Refusing non-local or non-hc_test database');
 const admin=new pg.Pool({connectionString:url.toString(),max:2});
 const stageURL=new URL(url.toString());
 stageURL.pathname='/hc_owner_stage_test';
 let stage=null,operator=null,runtime=null,dbCreated=false;
 let phase='guarding disposable database';
 let testFailure=null;
 const op='hc_owner_recovery_op_'+process.pid;
 const rt='hc_owner_recovery_runtime_'+process.pid;
 const groupNames=['hc_owner_stage_operator_privs','hc_owner_stage_runtime_privs'];
 const password=randomBytes(24).toString('hex');
 try{
  const guard=await admin.query(
   `SELECT current_database() AS db,
           EXISTS(SELECT 1 FROM pg_database WHERE datname='hc_owner_stage_test') AS has_stage,
           (SELECT count(*)::integer FROM pg_roles WHERE rolname=ANY($1::text[])) AS roles`,
   [[...groupNames,op,rt]]
  );
  assert.equal(guard.rows[0].db,'hc_test');
  assert.equal(guard.rows[0].has_stage,false,'must not reuse or delete any existing staging DB');
  assert.equal(guard.rows[0].roles,0,'must not reuse or alter existing roles');

  phase='creating fresh disposable owner database';
  await admin.query('CREATE DATABASE hc_owner_stage_test');
  dbCreated=true;
  phase='loading prerequisite schemas';
  stage=new pg.Pool({connectionString:stageURL.toString(),max:2});
  for(const filename of [
   'hc_staff_passkeys.sql','hc_admin_delegations.sql',
   'hc_first_owner_operator_activation.sql'
  ]) {
   await stage.query(await readFile(new URL('../db/'+filename,import.meta.url),'utf8'));
  }
  phase='provisioning isolated test-only roles';
  for(const group of groupNames)await stage.query('CREATE ROLE '+group+' NOLOGIN');
  await stage.query('CREATE ROLE '+op+" LOGIN PASSWORD '"+password+"'");
  await stage.query('CREATE ROLE '+rt+" LOGIN PASSWORD '"+password+"'");
  await stage.query('GRANT hc_owner_stage_operator_privs TO '+op);
  await stage.query('GRANT hc_owner_stage_runtime_privs TO '+rt);
  await stage.query('GRANT USAGE ON SCHEMA public TO hc_owner_stage_operator_privs, hc_owner_stage_runtime_privs');
  await stage.query(
   'GRANT SELECT, INSERT ON public.hc_first_owner_activations TO hc_owner_stage_operator_privs');
  phase='applying recovery candidate SQL in disposable database';
  await stage.query(await readFile(sql,'utf8'));

  const opURL=new URL(stageURL);
  opURL.username=op;opURL.password=password;
  operator=new pg.Pool({connectionString:opURL.toString(),max:1});
  const rtURL=new URL(stageURL);
  rtURL.username=rt;rtURL.password=password;
  runtime=new pg.Pool({connectionString:rtURL.toString(),max:1});

  phase='checking runtime and operator privilege separation';
  const privilege=await stage.query(
   `SELECT has_function_privilege($1,
       'public.hc_reissue_expired_first_owner_activation(bigint,text,text)','EXECUTE')
       AS runtime_can_reissue,
       has_function_privilege($2,
       'public.hc_reissue_expired_first_owner_activation(bigint,text,text)','EXECUTE')
       AS operator_can_reissue`,[rt,op]
  );
  assert.equal(privilege.rows[0].runtime_can_reissue,false);
  assert.equal(privilege.rows[0].operator_can_reissue,true);
  await assert.rejects(runtime.query(
   'SELECT public.hc_reissue_expired_first_owner_activation(1,$1,$2)',
   [digest(),'verified-operator']),/permission denied/i);
  await assert.rejects(operator.query(
   'UPDATE public.hc_first_owner_activations SET activation_digest=$1 WHERE employee_id=1',
   [digest()]),/permission denied/i);

  phase='inserting test authorization';
  const oldDigest=digest(),replacementDigest=digest();
  const now=Date.now();
  await stage.query(
   `INSERT INTO hc_first_owner_activations
      (employee_id,activation_digest,approved_at,expires_at,issued_by)
      VALUES(1,$1,$2,$3,'original-operator')`,
   [oldDigest,new Date(now-1000),new Date(now+60000)]
  );
  const reissue=()=>operator.query(
   'SELECT public.hc_reissue_expired_first_owner_activation($1,$2,$3) AS expires_at',
   [1,replacementDigest,'verified-operator']
  );
  phase='unexpired-authorization refusal';
  await assert.rejects(reissue(),/recovery denied/i,'unexpired authorization must refuse');
  await stage.query(
   `UPDATE hc_first_owner_activations
      SET approved_at=now()-interval '12 minutes',
          expires_at=now()-interval '2 minutes' WHERE employee_id=1`);

  phase='consumed-authorization refusal';
  await stage.query(
   `UPDATE hc_first_owner_activations
      SET consumed_at=now(),credential_id='credential-consumed-test' WHERE employee_id=1`);
  await assert.rejects(reissue(),/recovery denied/i,'consumed approval cannot renew');
  await stage.query(
   `UPDATE hc_first_owner_activations SET consumed_at=NULL,credential_id=NULL
      WHERE employee_id=1`);

  phase='existing-Owner refusal';
  await stage.query(
   "INSERT INTO hc_admin_principals(employee_id,role) VALUES(1,'owner')");
  await assert.rejects(reissue(),/recovery denied/i,'existing Owner blocks renewal');
  await stage.query('DELETE FROM hc_admin_principals WHERE employee_id=1');

  phase='existing-passkey refusal';
  await stage.query(
   `INSERT INTO hc_staff_passkeys(credential_id,employee_id,public_key)
      VALUES('already-registered-credential',1,$1)`,[randomBytes(32)]);
  await assert.rejects(reissue(),/recovery denied/i,'existing passkey blocks renewal');
  await stage.query('DELETE FROM hc_staff_passkeys WHERE employee_id=1');

  phase='fault-injection rollback of audit write';
  // Fault injection: an audit failure must roll back approval changes too.
  await stage.query(
   `CREATE FUNCTION public.hc_test_fail_owner_reissue_audit()
      RETURNS trigger LANGUAGE plpgsql AS
      'BEGIN RAISE EXCEPTION ''simulated audit write failure''; END;'`);
  await stage.query(
   `CREATE TRIGGER hc_test_fail_owner_reissue_audit
      BEFORE INSERT ON hc_first_owner_activation_reissues
      FOR EACH ROW EXECUTE FUNCTION public.hc_test_fail_owner_reissue_audit()`);
  await assert.rejects(reissue(),/simulated audit write failure/i);
  assert.equal((await stage.query(
   'SELECT activation_digest FROM hc_first_owner_activations WHERE employee_id=1'
  )).rows[0].activation_digest,oldDigest);
  await stage.query(
   'DROP TRIGGER hc_test_fail_owner_reissue_audit ON hc_first_owner_activation_reissues');
  await stage.query('DROP FUNCTION public.hc_test_fail_owner_reissue_audit()');

  phase='successful single recovery';
  const approved=await reissue();
  assert.equal(approved.rowCount,1);
  const row=(await stage.query(
   `SELECT activation_digest,approved_at,expires_at,issued_by,consumed_at,credential_id
      FROM hc_first_owner_activations WHERE employee_id=1`)).rows[0];
  assert.equal(row.activation_digest,replacementDigest);
  assert.equal(row.issued_by,'verified-operator');
  assert.equal(row.consumed_at,null);
  assert.equal(row.credential_id,null);
  const lengthMs=new Date(row.expires_at)-new Date(row.approved_at);
  assert.equal(lengthMs,600_000,'database, not workstation, controls the 10-minute window');
  assert.equal(new Date(approved.rows[0].expires_at).getTime(),
               new Date(row.expires_at).getTime());
  const log=await stage.query(
   'SELECT * FROM hc_first_owner_activation_reissues WHERE employee_id=1');
  assert.equal(log.rowCount,1);
  assert.equal(log.rows[0].previous_activation_digest,oldDigest);
  assert.equal(log.rows[0].replacement_activation_digest,replacementDigest);
  assert.equal(log.rows[0].previous_issued_by,'original-operator');
  phase='rejecting second recovery and enforcing append-only audit';
  await assert.rejects(reissue(),/recovery denied/i,'one recovery only, no silent reuse');
  await assert.rejects(
   stage.query('DELETE FROM hc_first_owner_activation_reissues'),
   /append-only/i,'even the DB owner cannot silently erase the audit');
  assert.equal((await stage.query(
   'SELECT count(*)::integer AS n FROM hc_first_owner_activation_reissues'
  )).rows[0].n,1);
 }catch(error){
  // Preserve the actual failing test step instead of allowing a subsequent
  // teardown problem to hide it with an unrelated SQL connection error.
  testFailure=new Error('Owner recovery test failed at ['+phase+']: '+error.message,{
   cause:error
  });
 }finally{
  const cleanupErrors=[];
  for(const [label,pool] of [['operator',operator],['runtime',runtime],['stage',stage]]){
   if(pool){
    try{await pool.end();}
    catch(error){cleanupErrors.push(label+' pool: '+error.message);}
   }
  }
  if(dbCreated){
   // Deliberately NEVER use WITH (FORCE): if connections unexpectedly remain,
   // show a useful cleanup error rather than killing a test connection.
   try{await admin.query('DROP DATABASE hc_owner_stage_test');}
   catch(error){cleanupErrors.push('drop disposable db: '+error.message);}
   for(const role of [op,rt,...groupNames]){
    try{await admin.query('DROP ROLE IF EXISTS '+role);}
    catch(error){cleanupErrors.push('drop throwaway role: '+error.message);}
   }
  }
  try{await admin.end();}
  catch(error){cleanupErrors.push('admin pool: '+error.message);}
  if(cleanupErrors.length){
   const detail='Disposable cleanup issues: '+cleanupErrors.join(' | ');
   if(testFailure){
    console.error(detail);
   }else{
    testFailure=new Error(detail);
   }
  }
 }
 if(testFailure)throw testFailure;
});
