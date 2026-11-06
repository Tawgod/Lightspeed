import test from 'node:test';
import assert from 'node:assert/strict';
import {createEmployeeAdminAccess} from '../services/security/employeeAdminAccess.js';
import {ADMIN_SETTINGS,listAdminSettingDescriptors,findAdminSettingDescriptor,validateAdminSettingDescriptors} from '../services/security/adminSettingsRegistry.js';

test('admin settings registry is source-owned, unique, grouped and read-only',()=>{
 assert.ok(ADMIN_SETTINGS.length>=10);
 assert.ok(ADMIN_SETTINGS.some(item=>item.section==='Tool Settings'));
 assert.ok(ADMIN_SETTINGS.some(item=>item.section==='Tool Permissions'));
 assert.equal(new Set(ADMIN_SETTINGS.map(item=>item.id)).size,ADMIN_SETTINGS.length);
 assert.equal(validateAdminSettingDescriptors(ADMIN_SETTINGS),true);
 const items=listAdminSettingDescriptors({section:'Tool Settings'});
 assert.ok(items.length>=3);
 items[0].label='Tampered';
 assert.notEqual(findAdminSettingDescriptor(items[0].id).label,'Tampered');
 assert.equal(findAdminSettingDescriptor('__proto__'),null);
 assert.throws(()=>validateAdminSettingDescriptors([{...ADMIN_SETTINGS[0],id:'invalid path'}]),TypeError);
 assert.throws(()=>validateAdminSettingDescriptors([ADMIN_SETTINGS[0],ADMIN_SETTINGS[0]]),TypeError);
});
function setup(){
 let time=2000000000000,identity='901',allowed=true,totp=true,passkey=false;
 let calls=[];
 const access=createEmployeeAdminAccess({
  verifyEmployeeSession:async()=>({
   employeeId:identity,active:true,
   binding:'signed-test-session-9876543210',expiresAtMs:time+600000
  }),
  verifyPasskey:async()=>passkey?({
   verified:true,employeeId:identity,method:'passkey',authenticatedAtMs:time-1000
  }):null,
  verifyTotp:async()=>totp?({
   verified:true,employeeId:identity,method:'totp',authenticatedAtMs:time-1000
  }):null,
  canAdmin:async grant=>{
   calls.push(grant);
   return allowed&&grant.employeeId==='901'&&
     ['admin.read','tools.settings.read','employees.pin.reset'].includes(grant.operation);
  },now:()=>time
 });
 return {access,calls,setAllowed:v=>allowed=v,setTotp:v=>totp=v,
  setPasskey:v=>passkey=v,setIdentity:v=>identity=v};
}
test('PIN-only, workstation-only, and unprivileged employees cannot access admin',async()=>{
 const h=setup();
 h.setTotp(false);
 await assert.rejects(h.access.authorize({context:{},operation:'admin.read'}),e=>e.status===403);
 h.setTotp(true);
 h.setAllowed(false);
 await assert.rejects(h.access.authorize({context:{},operation:'admin.read'}),e=>e.status===403);
 h.setAllowed(true);h.setIdentity('902');
 await assert.rejects(h.access.authorize({context:{},operation:'admin.read'}),e=>e.status===403);
});
test('authorized employee can enter admin with TOTP or passkey, not stale factor',async()=>{
 const h=setup();
 const totp=await h.access.authorize({context:{},operation:'admin.read'});
 assert.equal(totp.method,'totp');
 h.setTotp(false);h.setPasskey(true);
 assert.equal((await h.access.authorize({context:{},operation:'admin.read'})).method,'passkey');
});
test('TOTP admin entry does not authorize PIN-reset privileged action',async()=>{
 const h=setup();
 await assert.rejects(h.access.authorize({
  context:{},operation:'employees.pin.reset',requireStrong:true
 }),e=>e.status===403);
 h.setPasskey(true);
 const grant=await h.access.authorize({
  context:{},operation:'employees.pin.reset',requireStrong:true
 });
 assert.equal(grant.method,'passkey');
 assert.equal(grant.operation,'employees.pin.reset');
});
test('missing trusted verifiers cannot construct an admin gate',()=>{
 assert.throws(()=>createEmployeeAdminAccess(),TypeError);
 assert.throws(()=>createEmployeeAdminAccess({
  verifyEmployeeSession:async()=>{},canAdmin:async()=>true
 }),TypeError);
});
