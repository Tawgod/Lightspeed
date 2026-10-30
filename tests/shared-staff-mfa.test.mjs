import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createStaffMfaSessions } from '../services/security/staffMfaSessions.js';
import { createStaffMfaSessionRouter } from '../routes/staffMfaSession.js';
import { createStaffAccessBaseline } from '../services/security/staffAccessBaseline.js';
import { createStaffApprovedEnrollmentAdapters } from '../services/security/staffEnrollmentSettings.js';

const gen1 = 'cdd2ad1c-48b4-41d4-84d2-d4e3b030d571';
const gen2 = 'cdd2ad1c-48b4-41d4-84d2-d4e3b030d572';
const SECRET = 'test-only-MFA-binding-signing-key-for-hobby-corner';
function setup() {
  let clock = Date.parse('2026-10-30T21:40:00Z'), factor = gen1;
  let verifications = 0;
  const session = createStaffMfaSessions({
    secret: SECRET, now: () => clock,
    verifyBaseSession: async context => context?.valid === true
      ? {employeeId: context.employee || 17, active: true, binding: context.binding || 'signed-base-token-jti-17' }
      : null,
    totp: {
      verifyCode: async ({code}) => {
        verifications++;
        if (code !== '123456') throw Object.assign(new Error('No'), {status:401});
        return { verified: true, employeeId: '17', method: 'totp', authenticatedAtMs: clock };
      },
      getActiveGeneration: async () => factor
    }
  });
  return {
    session,
    base: {valid:true,employee:17,binding:'signed-base-token-jti-17'},
    clock: delta => { clock += delta; },
    rotate: () => { factor = gen2; },
    get calls() { return verifications; }
  };
}

test('MFA token is bound to active employee, base session and factor generation', async () => {
  const f = setup();
  const step = await f.session.authenticate({ context:f.base, code:'123456',sourceIp:'203.0.113.10' });
  assert.equal(step.expiresIn,300);
  assert.equal(step.token.split('.').length,2);
  assert.equal(f.calls,1);
  const verified = await f.session.verify({context:f.base,token:step.token});
  assert.deepEqual(verified, {
    verified:true,employeeId:'17',method:'totp',authenticatedAtMs:Date.parse('2026-10-30T21:40:00Z')
  });
  await assert.rejects(f.session.verify({context:{...f.base,binding:'different-valid-session-jti'},token:step.token}),
    e => e.code === 'HC_MFA_REQUIRED');
  await assert.rejects(f.session.verify({context:{...f.base,employee:18},token:step.token}),
    e => e.code === 'HC_MFA_REQUIRED');
  await assert.rejects(f.session.verify({context:{...f.base,valid:false},token:step.token}),
    e => e.code === 'HC_MFA_REQUIRED');
  await assert.rejects(f.session.verify({context:f.base,token:step.token.slice(0,-3)+'bad'}),
    e => e.code === 'HC_MFA_REQUIRED');
  f.rotate();
  await assert.rejects(f.session.verify({context:f.base,token:step.token}),
    e => e.code === 'HC_MFA_REQUIRED');
});
test('MFA expires and fails closed without second factor or active generation', async () => {
  const f = setup();
  await assert.rejects(f.session.authenticate({context:{valid:false},code:'123456'}),
    e => e.code === 'HC_MFA_REQUIRED');
  await assert.rejects(f.session.authenticate({context:f.base,code:'000000'}),
    e => e.status === 401);
  const step = await f.session.authenticate({context:f.base,code:'123456'});
  f.clock(300001);
  await assert.rejects(f.session.verify({context:f.base,token:step.token}),
    e => e.code === 'HC_MFA_REQUIRED');
  assert.throws(() => createStaffMfaSessions(),TypeError);
});

test('mobile MFA verification route never trusts role, employee ID or unsigned proof', async () => {
  let clock = Date.parse('2026-10-30T21:40:00Z');
  const f = createStaffMfaSessions({
    secret: SECRET, now:()=>clock,
    verifyBaseSession: async req => req.get('authorization') === 'Bearer signed'
      ? {employeeId:17,active:true,binding:'signed-server-session-jti-17'} : null,
    totp:{
      verifyCode:async ({code})=>{
        if(code!=='123456')throw Object.assign(new Error('invalid'),{status:401});
        return {verified:true,employeeId:'17',method:'totp',authenticatedAtMs:clock};
      },
      getActiveGeneration:async()=>gen1
    }
  });
  const app=express();
  app.use('/staff-mfa',createStaffMfaSessionRouter({mfa:f}));
  const server=await new Promise(resolve=>{const a=app.listen(0,'127.0.0.1',()=>resolve(a));});
  const base='http://127.0.0.1:'+server.address().port+'/staff-mfa';
  try{
    const malicious=await fetch(base+'/session',{
      method:'POST',headers:{'Content-Type':'application/json','X-Employee-Role':'admin','X-MFA-Verified':'yes'},
      body:JSON.stringify({code:'123456'})
    });
    assert.equal(malicious.status,401);
    const extra=await fetch(base+'/session',{
      method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer signed'},
      body:JSON.stringify({code:'123456',verified:true})
    });
    assert.equal(extra.status,400);
    const allowed=await fetch(base+'/session',{
      method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer signed'},
      body:JSON.stringify({code:'123456'})
    });
    assert.equal(allowed.status,200);
    assert.match(allowed.headers.get('cache-control'),/no-store/);
    const info=await allowed.json();
    assert.equal(info.method,'totp');
    assert.ok(info.token);
    const replay=await fetch(base+'/session',{headers:{
      'Authorization':'Bearer signed','X-HC-MFA-Session':info.token
    }});
    assert.deepEqual(await replay.json(), {
      verified:true,method:'totp',authenticatedAtMs:clock
    });
    const unrelated=await fetch(base+'/session',{headers:{'X-HC-MFA-Session':info.token}});
    assert.equal(unrelated.status,401);
  } finally {await new Promise(resolve=>server.close(resolve));}
});

test('manager approval composition denies QR enrollment until approved and consumes grant once',async()=>{
  let state='requested';
  const approvals={
    status:async()=>({state}),
    start:async()=>{if(state!=='approved')return false;state='started';return true;},
    allowConfirmation:async()=>state==='started',
    finish:async()=>{if(state!=='started')return false;state='finished';return true;}
  };
  const adapters=createStaffApprovedEnrollmentAdapters({approvals});
  const context={};
  assert.equal(await adapters.authorizeSettings({request:context,action:'authenticator.status'}),true);
  assert.equal(await adapters.authorizeSettings({request:context,action:'authenticator.enroll'}),false);
  assert.equal(await adapters.authorizeEnrollment({context,phase:'begin'}),false);
  state='approved';
  assert.equal(await adapters.authorizeSettings({request:context,action:'authenticator.enroll'}),true);
  assert.equal(await adapters.authorizeEnrollment({context,phase:'begin'}),true);
  assert.equal(await adapters.authorizeEnrollment({context,phase:'begin'}),false);
  assert.equal(await adapters.authorizeSettings({request:context,action:'authenticator.confirm'}),true);
  assert.equal(await adapters.authorizeEnrollment({context,phase:'confirm'}),true);
  assert.equal(await adapters.authorizeEnrollment({context,phase:'finish'}),true);
  assert.equal(await adapters.authorizeEnrollment({context,phase:'confirm'}),false);
  assert.throws(()=>createStaffApprovedEnrollmentAdapters(),TypeError);
});

test('signed TOTP proof integrates with exact-operation gate but never enables privileged writes',async()=>{
  const f=setup();
  const step=await f.session.authenticate({context:f.base,code:'123456'});
  const gate=createStaffAccessBaseline({
    verifyEmployeeSession:async()=>({id:17,active:true}),
    verifyStepUp:async request=>f.session.verify({context:request,token:step.token}),
    checkPermission:async ({operation})=>['tools.read','tools.stage'].includes(operation)
  });
  const read=await gate.authorize({request:f.base,action:'tools.read'});
  assert.equal(read.factorMethod,'totp');
  await assert.rejects(gate.authorize({request:f.base,action:'products.write'}),
    e=>e.code==='HC_STAFF_ACCESS_DENIED');
  f.rotate();
  await assert.rejects(gate.authorize({request:f.base,action:'tools.read'}),
    e=>e.code==='HC_STAFF_ACCESS_DENIED');
});
