import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {createAdminDelegations} from '../services/security/adminDelegationsPostgres.js';
import {createEmployeeAdminAccess} from '../services/security/employeeAdminAccess.js';

const database=process.env.HC_TEST_DATABASE_URL;
test('real Timeclock-backed Owners may appoint other Owners; cannot self-promote or remove final Owner',
  {skip:!database?'Disposable hc_test PostgreSQL required':false},async()=>{
  if(!/hc_test(?:$|[/?])/.test(database))throw Error('Refusing non-disposable database');
  const pool=new pg.Pool({connectionString:database,max:3});
  const schema='hc_multi_owner_'+process.pid;
  let actor='901',method='passkey',allowTarget=true;
  const context={session:'test-only-bound-employee'};
  let delegates;
  const now=()=>Date.parse('2026-11-10T16:00:00Z');
  const access=createEmployeeAdminAccess({
    now,
    verifyEmployeeSession:async req=>{
      if(req!==context)throw Error('session mismatch');
      return {employeeId:actor,active:true,binding:'long-verified-test-session-901',
        expiresAtMs:now()+60000};
    },
    verifyPasskey:async()=>method==='passkey'
      ?{verified:true,employeeId:actor,method:'passkey',authenticatedAtMs:now()-1000}:null,
    verifyTotp:async()=>method==='totp'
      ?{verified:true,employeeId:actor,method:'totp',authenticatedAtMs:now()-1000}:null,
    canAdmin:arg=>delegates.canAdmin(arg)
  });
  let testPool;
  try {
    await pool.query('CREATE SCHEMA '+schema);
    testPool=new pg.Pool({connectionString:database,max:3,
      options:'-c search_path='+schema});
    await testPool.query(await readFile(
      new URL('../db/hc_admin_delegations.sql',import.meta.url),'utf8'));
    delegates=createAdminDelegations({
      pool:testPool,adminAccess:access,
      verifyTargetEmployee:async id=>allowTarget&&['901','902','903'].includes(id)
        ?{id,active:true}:null
    });
    const reason='Owner authorized an additional responsible administrator';
    // Simulate an explicit one-time system operator initial Owner assignment.
    // This is NOT the browser route or a PIN-only enrollment.
    await testPool.query("INSERT INTO hc_admin_principals(employee_id,role) VALUES(901,'owner')");
    await assert.rejects(delegates.changeOwnerRole({
      context,targetEmployeeId:'901',enabled:true,reason
    }),e=>e?.status===403,'cannot appoint oneself');
    await assert.rejects(delegates.changeOwnerRole({
      context,targetEmployeeId:'999',enabled:true,reason
    }),e=>e?.status===403,'target must exist and be active in canonical Timeclock');
    method='totp';
    await assert.rejects(delegates.changeOwnerRole({
      context,targetEmployeeId:'902',enabled:true,reason
    }),e=>e?.status===403,'TOTP alone cannot appoint Owners');
    method='passkey';
    await delegates.changeOwnerRole({context,targetEmployeeId:'902',enabled:true,reason});
    assert.equal((await delegates.capabilitiesForVerifiedEmployee('902')).role,'owner');
    actor='902';
    await delegates.changeOwnerRole({context,targetEmployeeId:'903',enabled:true,reason});
    assert.equal((await delegates.canAdmin({
      employeeId:'903',operation:'admin.delegation.manage'})),true);
    await delegates.changeOwnerRole({
      context,targetEmployeeId:'901',enabled:false,reason:'Two other active Owners remain'
    });
    assert.equal((await delegates.canAdmin({
      employeeId:'901',operation:'admin.read'})),false);
    actor='903';
    await delegates.changeOwnerRole({
      context,targetEmployeeId:'902',enabled:false,reason:'Revoke one of two remaining Owners'
    });
    const before=await testPool.query(
      "SELECT employee_id FROM hc_admin_principals WHERE role='owner' AND active=true");
    assert.deepEqual(before.rows.map(r=>String(r.employee_id)),['903']);
    await assert.rejects(delegates.changeOwnerRole({
      context,targetEmployeeId:'903',enabled:false,reason:'Cannot remove final administrator'
    }),e=>e?.status===403,'cannot self-revoke, including final Owner');
    // Final Owner cannot be revoked by an inactive former Owner either.
    actor='902';
    await assert.rejects(delegates.changeOwnerRole({
      context,targetEmployeeId:'903',enabled:false,reason:'Attempt to remove last Owner'
    }),e=>e?.status===403);
    actor='903';
    allowTarget=false;
    await assert.rejects(delegates.changeOwnerRole({
      context,targetEmployeeId:'901',enabled:true,reason:'Inactive employee must not become Owner'
    }),e=>e?.status===403);
    const audits=await testPool.query(
      "SELECT kind FROM hc_admin_authorization_events ORDER BY created_at");
    assert.equal(audits.rows.filter(x=>x.kind==='owner_appoint').length,2);
    assert.equal(audits.rows.filter(x=>x.kind==='owner_revoke').length,2);
    await assert.rejects(testPool.query('DELETE FROM hc_admin_authorization_events'),
      /append-only/);
  }finally {
    if(testPool)await testPool.end();
    await pool.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE').catch(()=>{});
    await pool.end();
  }
});
