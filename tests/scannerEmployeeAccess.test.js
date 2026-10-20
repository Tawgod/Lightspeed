import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const timeclock=fs.readFileSync('timeclock/server.js','utf8');
const start=timeclock.indexOf('async function scannerEffectivePermissions(employee){');
const end=timeclock.indexOf('\n// Called only by the trusted Lightspeed API',start);
assert.ok(start>=0&&end>start);
const fn=new Function('employee',timeclock.slice(start,end).replace('async function scannerEffectivePermissions(employee){','').replace(/}\s*$/,''));
test('any active Timeclock employee has both scanner permissions',()=>{
 return Promise.resolve(fn({id:3,name:'Staff',active:true})).then(x=>{
  assert.equal(x.canLookup,true);assert.equal(x.canApprove,true);assert.equal(x.permissionSource,'timeclock_employee');
 });
});
test('inactive or missing employee never gains scanner access',async()=>{
 for(const e of [{id:3,active:false},{id:0,active:true},{}]){
  const x=await fn(e);assert.equal(x.canApprove,false);assert.equal(x.canLookup,false);
 }
});
test('PIN and session recheck both query active employees',()=>{
 assert.match(timeclock,/WHERE pin_hash=\$1 AND active=TRUE LIMIT 1/);
 assert.match(timeclock,/WHERE id=\$1 AND active=TRUE LIMIT 1/);
});
