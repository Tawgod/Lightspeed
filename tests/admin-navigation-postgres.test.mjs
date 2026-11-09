import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import express from 'express';
import {createAdminNavigationAccessRouter,createAdminNavigationGrantReader} from '../services/security/adminNavigationAccess.js';

const databaseUrl=process.env.HC_TEST_DATABASE_URL;
test('disposable PostgreSQL: Owner, delegated manager, ordinary staff and revocation',{
 skip:!databaseUrl?'HC_TEST_DATABASE_URL is not configured':false
},async()=>{
 const url=new URL(databaseUrl);
 // Never run identity/permission fixture DDL against a connected Railway DB.
 if(url.hostname!=='127.0.0.1'&&url.hostname!=='localhost')
  throw new Error('Refusing non-local test database');
 if(url.pathname!=='/hc_test')throw new Error('Refusing non-hc_test database');
 const client=new pg.Client({connectionString:databaseUrl});
 await client.connect();
 let activeEmployee='901',sessionOk=true;
 let server=null;
 try{
  await client.query('BEGIN');
  await client.query('CREATE TEMP TABLE hc_admin_principals (employee_id bigint PRIMARY KEY,role text NOT NULL,active boolean NOT NULL DEFAULT true)');
  await client.query('CREATE TEMP TABLE hc_admin_grants (employee_id bigint NOT NULL,operation text NOT NULL,PRIMARY KEY(employee_id,operation))');
  const grants=createAdminNavigationGrantReader({pool:client});
  const verifyEmployee=async req=>{
   if(!sessionOk||req.get('authorization')!=='Bearer signed-fixture')throw Error('Invalid signed session');
   if(!['901','902','903'].includes(activeEmployee))throw Error('Not an active Timeclock employee');
   return {id:activeEmployee,active:true};
  };
  const app=express();
  app.use('/api/admin',createAdminNavigationAccessRouter({verifyEmployee,hasAdminRead:grants}));
  server=await new Promise(resolve=>{
   const instance=app.listen(0,'127.0.0.1',()=>resolve(instance));
  });
  const endpoint='http://127.0.0.1:'+server.address().port+'/api/admin/navigation-access';
  const check=async()=>fetch(endpoint,{headers:{Authorization:'Bearer signed-fixture'}});
  // No Owner bootstrap/role creation on GET; database is empty by default.
  assert.equal((await check()).status,403);
  assert.equal((await client.query('SELECT count(*)::int AS n FROM hc_admin_principals')).rows[0].n,0);
  // Only the synthetic test actor is provisioned. No real Timeclock ID is read.
  await client.query("INSERT INTO hc_admin_principals(employee_id,role,active) VALUES(901,'owner',true),(902,'delegated_admin',true)");
  assert.equal((await check()).status,200,'test Owner may navigate only after separate provision');
  activeEmployee='902';
  assert.equal((await check()).status,403,'manager without explicit admin.read is denied');
  await client.query("INSERT INTO hc_admin_grants(employee_id,operation) VALUES(902,'tools.settings.read')");
  assert.equal((await check()).status,403,'unrelated management grant cannot open Admin');
  await client.query("INSERT INTO hc_admin_grants(employee_id,operation) VALUES(902,'admin.read')");
  assert.equal((await check()).status,200,'manager with explicit admin.read may see link');
  await client.query("DELETE FROM hc_admin_grants WHERE employee_id=902 AND operation='admin.read'");
  assert.equal((await check()).status,403,'revocation effective on next navigation request');
  await client.query("INSERT INTO hc_admin_grants(employee_id,operation) VALUES(902,'admin.read')");
  await client.query('UPDATE hc_admin_principals SET active=false WHERE employee_id=902');
  assert.equal((await check()).status,403,'inactive admin is denied even with leftover grant');
  activeEmployee='903';
  assert.equal((await check()).status,403,'ordinary employee never inferred an admin');
  activeEmployee='901';sessionOk=false;
  assert.equal((await check()).status,403,'revoked or expired staff session denied');
  sessionOk=true;
  await client.query('UPDATE hc_admin_principals SET active=false WHERE employee_id=901');
  assert.equal((await check()).status,403,'inactive Owner denied');
  assert.equal((await client.query('SELECT count(*)::int AS n FROM hc_admin_principals')).rows[0].n,2);
  // No endpoint is authorized to change grants; only the fixture did so.
  assert.equal((await fetch(endpoint,{method:'POST'})).status,404);
 }finally{
  if(server)await new Promise(resolve=>server.close(resolve));
  await client.query('ROLLBACK').catch(()=>{});
  await client.end();
 }
});
