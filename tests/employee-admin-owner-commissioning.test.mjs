import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {createAdminOwnerCommissioning} from '../services/security/adminOwnerCommissioning.js';

const url=process.env.HC_TEST_DATABASE_URL;
const guard={skip:!url?'Disposable PostgreSQL required':false};
test('Owner commissioning binds the explicitly configured active employee and is single use',guard,async()=>{
 if(!/hc_test/.test(url))throw Error('Refusing non-disposable database.');
 const pool=new pg.Pool({connectionString:url,max:5});
 const instant=2000000000000;
 let id='902',method='passkey',purpose='owner.commission';
 const base={};
 try{
  await pool.query(await readFile(new URL('../db/hc_admin_delegations.sql',import.meta.url),'utf8'));
  // This is a disposable hc_test database, never a production connection.
  await pool.query('TRUNCATE hc_admin_grants,hc_admin_grant_scopes,hc_admin_setting_scopes,hc_employee_tool_grants,hc_admin_principals');
  const make=expectedOwnerEmployeeId=>createAdminOwnerCommissioning({
   pool,expectedOwnerEmployeeId,now:()=>instant,
   verifyEmployee:async()=>({employeeId:id,active:true}),
   verifyOwnerPasskey:async()=>({
    verified:true,employeeId:id,method,purpose,authenticatedAtMs:instant-1000
   })
  });
  const commissioner=make('901');
  await assert.rejects(commissioner.commission({context:base}),e=>e.status===403,
   'different employee cannot claim owner despite valid passkey');
  id='901';method='totp';
  await assert.rejects(commissioner.commission({context:base}),e=>e.status===403,
   'a TOTP login is not sufficient to commission owner');
  method='passkey';purpose='admin.read';
  await assert.rejects(commissioner.commission({context:base}),e=>e.status===403,
   'ordinary passkey entry cannot commission owner');
  purpose='owner.commission';
  const result=await commissioner.commission({context:base});
  assert.equal(result.employeeId,'901');
  assert.equal(result.role,'owner');
  await assert.rejects(commissioner.commission({context:base}),e=>e.status===403);
  id='902';
  await assert.rejects(make('902').commission({context:base}),e=>e.status===403,
   'no second owner may be self-appointed');
  const rows=await pool.query("SELECT employee_id FROM hc_admin_principals WHERE role='owner'");
  assert.deepEqual(rows.rows.map(r=>String(r.employee_id)),['901']);
 }finally{await pool.end();}
});
test('Owner commissioning refuses missing independent employee identity mapping and verifier',()=>{
 assert.throws(()=>createAdminOwnerCommissioning(),TypeError);
});
