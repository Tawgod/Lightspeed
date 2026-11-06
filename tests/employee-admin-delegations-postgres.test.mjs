import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {createAdminDelegations} from '../services/security/adminDelegationsPostgres.js';
import {createEmployeeAdminAccess} from '../services/security/employeeAdminAccess.js';

const url=process.env.HC_TEST_DATABASE_URL;
const guarded={skip:!url?'Disposable PostgreSQL required':false};
test('Owner delegates onboarding and scoped tools but not private employee data or admin escalation',guarded,async()=>{
 if(!/hc_test/.test(url))throw Error('Refusing non-disposable database.');
 const pool=new pg.Pool({connectionString:url,max:5});
 let actor='901',factor='passkey';
 const context={};
 const fresh=()=>2000000000000;
 const identity=async()=>({
  employeeId:actor,active:true,binding:'test-signed-session-binding-12345678',
  expiresAtMs:fresh()+600000
 });
 let delegates;
 const access=createEmployeeAdminAccess({
  verifyEmployeeSession:identity,
  verifyPasskey:async()=>factor==='passkey'?{
   verified:true,employeeId:actor,method:'passkey',authenticatedAtMs:fresh()-1000
  }:null,
  verifyTotp:async()=>factor==='totp'?{
   verified:true,employeeId:actor,method:'totp',authenticatedAtMs:fresh()-1000
  }:null,
  canAdmin:input=>delegates.canAdmin(input),now:fresh
 });
 delegates=createAdminDelegations({pool,adminAccess:access,
  verifyTargetEmployee:async id=>['901','902','903'].includes(id)?{id,active:true}:null
 });
 try{
  await pool.query(await readFile(new URL('../db/hc_admin_delegations.sql',import.meta.url),'utf8'));
  // Test-only, offline-simulated commissioning. Production must use
  // independent strong owner identity proof and reviewed migration.
  await pool.query("INSERT INTO hc_admin_principals(employee_id,role) VALUES(901,'owner')");
  const initial=await delegates.capabilitiesForVerifiedEmployee('901');
  assert.equal(initial.role,'owner');
  assert.ok(initial.operations.includes('admin.delegation.manage'));
  assert.equal(await delegates.canAdmin({employeeId:'902',operation:'admin.read'}),false);
  assert.equal(await delegates.canAdmin({employeeId:'903',operation:'admin.read'}),false);
  const reason='Owner delegated onboarding and approved tool administration';
  await assert.rejects(
   delegates.changeAdminGrant({context,targetEmployeeId:'999',operation:'admin.read',enabled:true,reason}),
   e=>e.status===403,'unknown or inactive Timeclock employee cannot be granted admin rights'
  );
  for(const permission of ['admin.read','employees.onboard','tools.settings.read','tools.settings.manage','permissions.read','permissions.manage']){
   await delegates.changeAdminGrant({context,targetEmployeeId:'902',operation:permission,enabled:true,reason});
  }
  const manager=await delegates.capabilitiesForVerifiedEmployee('902');
  assert.equal(manager.role,'delegated_admin');
  assert.ok(manager.operations.includes('employees.onboard'));
  assert.ok(!manager.operations.includes('employees.private.read'));
  assert.equal(await delegates.canAdmin({employeeId:'902',operation:'employees.private.read'}),false);
  assert.equal(await delegates.canAdmin({employeeId:'902',operation:'employees.pin.reset'}),false);
  assert.equal(await delegates.canAdmin({employeeId:'902',operation:'timeclock.read'}),false);
  assert.equal(await delegates.canAdmin({employeeId:'902',operation:'admin.delegation.manage'}),false);
  await delegates.changeGrantScope({
   context,targetEmployeeId:'902',toolOperation:'products.draft',enabled:true,reason
  });
  await delegates.changeSettingScope({
   context,targetEmployeeId:'902',settingId:'productManager.defaults',enabled:true,reason
  });
  assert.equal(await delegates.canManageSetting({employeeId:'902',settingId:'productManager.defaults'}),true);
  assert.equal(await delegates.canManageSetting({employeeId:'902',settingId:'scanner.review'}),false);
  assert.equal(await delegates.canManageSetting({employeeId:'902',settingId:'employees.pin'}),false);
  actor='902';factor='totp';
  assert.equal((await access.authorize({context,operation:'admin.read'})).method,'totp');
  await assert.rejects(
   delegates.changeEmployeeToolGrant({context,targetEmployeeId:'903',toolOperation:'products.draft',enabled:true,reason}),
   e=>e.status===403,
   'TOTP-only entry cannot grant staff tool permissions'
  );
  factor='passkey';
  await delegates.changeEmployeeToolGrant({
   context,targetEmployeeId:'903',toolOperation:'products.draft',enabled:true,reason
  });
  const granted=await pool.query(
   'SELECT operation FROM hc_employee_tool_grants WHERE employee_id=903');
  assert.deepEqual(granted.rows.map(x=>x.operation),['products.draft']);
  await assert.rejects(
   delegates.changeEmployeeToolGrant({context,targetEmployeeId:'903',toolOperation:'products.create',enabled:true,reason}),
   e=>e.status===403,'manager may not grant operations outside owner scope'
  );
  await assert.rejects(
   delegates.changeAdminGrant({context,targetEmployeeId:'903',operation:'admin.read',enabled:true,reason}),
   e=>e.status===403,'delegated administrator cannot create other administrators'
  );
  await assert.rejects(
   delegates.changeEmployeeToolGrant({context,targetEmployeeId:'901',toolOperation:'products.draft',enabled:true,reason}),
   e=>e.status===403,'cannot change owner permissions'
  );
  actor='901';
  await delegates.changeAdminGrant({
   context,targetEmployeeId:'902',operation:'admin.read',enabled:false,reason:'Owner revoked delegated admin access'
  });
  assert.equal(await delegates.canAdmin({employeeId:'902',operation:'tools.settings.manage'}),false);
  assert.equal(await delegates.canManageSetting({employeeId:'902',settingId:'productManager.defaults'}),false);
  actor='902';factor='passkey';
  await assert.rejects(access.authorize({context,operation:'admin.read'}),e=>e.status===403);
  const events=await pool.query('SELECT kind FROM hc_admin_authorization_events');
  assert.ok(events.rowCount>=9);
  await assert.rejects(pool.query('DELETE FROM hc_admin_authorization_events'),/append-only/);
  const testWrite=await pool.query('SELECT count(*) AS n FROM hc_employee_tool_grants');
  assert.equal(Number(testWrite.rows[0].n),1);
 }finally{await pool.end();}
});
