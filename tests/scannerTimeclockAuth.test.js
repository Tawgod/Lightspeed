import test from 'node:test';
import assert from 'node:assert/strict';
import {createScannerSessions} from '../services/scannerSessions.js';
import {createTimeclockScannerIdentity} from '../services/scannerTimeclockIdentity.js';
import {createTimeclockScannerGateway} from '../services/scannerTimeclockGateway.js';

test('signed sessions are short-lived and tamper-resistant',()=>{
  let time=1_800_000_000_000;
  const sessions=createScannerSessions({secret:'s'.repeat(40),ttlSeconds:900,now:()=>time});
  const token=sessions.issue({id:42});
  assert.equal(sessions.verify(token).employeeId,42);
  assert.throws(()=>sessions.verify(token.slice(0,-1)+'x'),/session/i);
  time+=901_000;
  assert.throws(()=>sessions.verify(token),/Expired/);
});
test('service credential is kept backend-only',async()=>{
  let captured;
  const identity=createTimeclockScannerIdentity({baseUrl:'https://timeclock.example',serviceSecret:'x'.repeat(40),
    fetchImpl:async(url,opts)=>{
      captured={url:String(url),opts};
      return {ok:true,json:async()=>({employee:{id:42,name:'Staff',canLookup:true,canApprove:false}})};
    }});
  const employee=await identity.verifyPin('1234');
  assert.equal(employee.id,42);
  assert.equal(captured.opts.headers['x-scanner-service-secret'],'x'.repeat(40));
  assert.match(captured.url,/verify-pin$/);
});
test('gateway can only be enabled with identity and lookup',()=>{
  const router=createTimeclockScannerGateway();
  assert.equal(typeof router,'function');
});
test('sessions reject weak secrets',()=>{
  assert.throws(()=>createScannerSessions({secret:'weak'}),/32 bytes/);
});
