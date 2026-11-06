import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {createAdminSessionPolicyStore} from '../services/security/adminSessionPolicyPostgres.js';

const dbUrl=process.env.HC_TEST_DATABASE_URL;
const guarded={skip:!dbUrl?'Disposable PostgreSQL test database required':false};
test('durable session policy updates require strong admin, reject stale versions and persist immutable audit',guarded,async()=>{
 if(!/hc_test/.test(dbUrl))throw Error('Refusing non-disposable test database.');
 const pool=new pg.Pool({connectionString:dbUrl});
 let strong=true;
 try{
  await pool.query(await readFile(new URL('../db/hc_admin_session_policies.sql',import.meta.url),'utf8'));
  const access={
   authorize:async({operation,requireStrong})=>{
    if(requireStrong&&!strong)throw Object.assign(new Error('strong factor required'),{status:403});
    assert.ok(['sessions.policy.read','sessions.policy.manage'].includes(operation));
    return {employeeId:'901',method:strong?'passkey':'totp'};
   }
  };
  const store=createAdminSessionPolicyStore({pool,adminAccess:access});
  const initial=await store.current({context:{}});
  assert.equal(initial.version,1);
  assert.equal(initial.policy.remote.absoluteSeconds,900);
  const next={
   'approved-workstation':{idleSeconds:1800,absoluteSeconds:28800},
   remote:{idleSeconds:900,absoluteSeconds:3600}
  };
  strong=false;
  await assert.rejects(store.update({
   context:{},expectedVersion:1,policy:next,reason:'Owner-approved policy update'
  }),e=>e.status===403);
  strong=true;
  const updated=await store.update({
   context:{},expectedVersion:1,policy:next,reason:'Owner-approved policy update'
  });
  assert.equal(updated.version,2);
  assert.equal(updated.policy['approved-workstation'].absoluteSeconds,28800);
  await assert.rejects(store.update({
   context:{},expectedVersion:1,policy:next,reason:'Outdated browser edit attempt'
  }),e=>e.code==='HC_ADMIN_POLICY_CONFLICT');
  const saved=await store.current({context:{}});
  assert.equal(saved.version,2);
  const events=await pool.query(
   'SELECT employee_id,old_version,new_version,reason,previous_policy,next_policy FROM hc_admin_session_policy_events');
  assert.equal(events.rowCount,1);
  assert.equal(String(events.rows[0].employee_id),'901');
  assert.equal(Number(events.rows[0].old_version),1);
  assert.equal(Number(events.rows[0].new_version),2);
  assert.equal(events.rows[0].previous_policy.remote.absoluteSeconds,900);
  assert.equal(events.rows[0].next_policy.remote.absoluteSeconds,3600);
  await assert.rejects(pool.query('DELETE FROM hc_admin_session_policy_events'),/append-only/);
  assert.equal((await pool.query('SELECT count(*) AS n FROM hc_admin_session_policy_events')).rows[0].n,'1');
 }finally{await pool.end();}
});
