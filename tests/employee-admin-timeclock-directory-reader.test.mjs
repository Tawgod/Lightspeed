import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createAdminTimeclockDirectoryReader} from '../services/security/adminTimeclockDirectoryReader.js';

test('Timeclock roster adapter uses only no-sync route with a backend-only secret',async()=>{
 const requests=[];
 const reader=createAdminTimeclockDirectoryReader({
  baseUrl:'https://example.test/',adminSecret:'x'.repeat(40),
  fetchImpl:async(url,options)=>{
   requests.push({url:url.href,options});
   return {ok:true,json:async()=>({
    source:'timeclock',readOnly:true,count:1,
    employees:[{id:901,name:'Fixture',active:true}]
   })};
  }
 });
 const employees=await reader();
 assert.equal(employees[0].name,'Fixture');
 assert.equal(requests.length,1);
 assert.equal(requests[0].url,'https://example.test/api/timeclock/admin/employees/readonly');
 assert.equal(requests[0].options.method,'GET');
 assert.equal(requests[0].options.redirect,'error');
 assert.equal(requests[0].options.headers['x-timeclock-admin-secret'].length,40);
 assert.equal(requests[0].options.body,undefined);
});
test('adapter rejects unsafe remote HTTP, credentials in URLs and response forgery',async()=>{
 assert.throws(()=>createAdminTimeclockDirectoryReader({baseUrl:'http://example.test/',adminSecret:'x'.repeat(40)}),TypeError);
 assert.throws(()=>createAdminTimeclockDirectoryReader({baseUrl:'https://bad:pass@example.test/',adminSecret:'x'.repeat(40)}),TypeError);
 assert.throws(()=>createAdminTimeclockDirectoryReader({baseUrl:'https://example.test/',adminSecret:'x'}),TypeError);
 const reader=createAdminTimeclockDirectoryReader({
  baseUrl:'http://127.0.0.1/',adminSecret:'x'.repeat(40),
  fetchImpl:async()=>({ok:true,json:async()=>({employees:[],count:0,source:'lightspeed',readOnly:true})})
 });
 await assert.rejects(reader(),/Invalid Timeclock directory response/);
});
test('new Timeclock route does not invoke Lightspeed sync and is backend-secret gated',async()=>{
 const source=await readFile(new URL('../timeclock/server.js',import.meta.url),'utf8');
 const route=source.match(/app\.get\('\/api\/timeclock\/admin\/employees\/readonly',[\s\S]*?\n\}\);/);
 assert.ok(route,'required non-mutating Timeclock endpoint missing');
 assert.match(route[0],/x-timeclock-admin-secret/);
 assert.match(route[0],/await listEmployees\(\)/);
 assert.doesNotMatch(route[0],/syncLightspeedUsers|assignEmployeePin|INSERT|UPDATE|DELETE|POST/);
});
