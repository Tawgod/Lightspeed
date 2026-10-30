import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createScannerSessions } from '../services/scannerSessions.js';
import { createStaffAuthGateway } from '../services/staffAuthGateway.js';

test('bound identity exposes an HMAC-verified session jti without changing legacy verifier shape', () => {
  let now = Date.parse('2026-10-30T20:00:00Z');
  const sessions = createScannerSessions({
    secret: 'test-only-signed-base-session-binding-key-123456789',
    now:()=>now,ttlSeconds:900
  });
  const token=sessions.issue({id:17});
  assert.deepEqual(sessions.verify(token),{employeeId:17});
  const bound=sessions.verifyBound(token);
  assert.equal(bound.employeeId,17);
  assert.match(bound.sessionId,/^[a-f0-9]{32}$/);
  assert.ok(!token.includes(bound.sessionId));
  assert.equal(bound.expiresAtMs, now+900000);
  assert.throws(()=>sessions.verifyBound(token.slice(0,-4)+'evil'),e=>e.status===401);
  now+=900000;
  assert.throws(()=>sessions.verifyBound(token),e=>e.status===401);
});

test('staff gateway only yields bound sessions after signed PIN login and Timeclock reauthorization',async()=>{
  let active=true;
  const auth=createStaffAuthGateway({
    identity:{
      verifyPin:async pin=>pin==='1234'?{id:17,name:'Employee'}:
        Promise.reject(Object.assign(new Error('invalid'),{status:401})),
      authorize:async id=>active && Number(id)===17?{id:17,name:'Employee'}:null
    },
    sessionSecret:'test-only-staff-gateway-signing-secret-123456789',
    loginLimiter:async()=>true
  });
  const app=express();
  app.use('/api/staff-auth',auth.router);
  app.get('/bound',async(req,res)=>{
    try{
      const value=await auth.verifyBoundEmployee(req);
      return res.json({id:value.id,active:value.active,binding:value.binding});
    }catch(e){return res.status(e.status||403).json({error:'denied'})}
  });
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const base='http://127.0.0.1:'+server.address().port;
  try{
    const attempt=await fetch(base+'/api/staff-auth/session',{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin:'1234'})
    });
    assert.equal(attempt.status,200);
    const token=(await attempt.json()).token;
    const missing=await fetch(base+'/bound',{headers:{'X-Employee-Role':'admin'}});
    assert.equal(missing.status,401);
    const good=await fetch(base+'/bound',{headers:{Authorization:'Bearer '+token}});
    assert.equal(good.status,200);
    const data=await good.json();
    assert.equal(data.id,'17');
    assert.equal(data.active,true);
    assert.match(data.binding,/^[a-f0-9]{32}$/);
    active=false;
    const revoked=await fetch(base+'/bound',{headers:{Authorization:'Bearer '+token}});
    assert.equal(revoked.status,403);
  }finally{await new Promise(resolve=>server.close(resolve))}
});
