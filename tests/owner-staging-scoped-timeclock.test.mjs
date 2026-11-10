import test from 'node:test';
import assert from 'node:assert/strict';
import {createTimeclockScannerIdentity} from '../services/scannerTimeclockIdentity.js';

const employee={id:42,name:'Fixture Owner',canLookup:true,canApprove:true,
  permissionSource:'timeclock_employee'};
test('Owner staging mode uses separate paths and header',async()=>{
  const calls=[];
  const identity=createTimeclockScannerIdentity({
    baseUrl:'https://timeclock.example.test',
    serviceSecret:'owner-service-dedicated-secret-0123456789',
    mode:'owner-staging',
    fetchImpl:async(url,options)=>{
      calls.push({url:String(url),headers:options.headers,body:JSON.parse(options.body)});
      return {ok:true,json:async()=>({employee})};
    }
  });
  const verified=await identity.verifyPin('1234');
  const authorized=await identity.authorize(42);
  assert.equal(verified.id,42);
  assert.equal(authorized.id,42);
  assert.equal(calls.length,2);
  assert.equal(calls[0].url,'https://timeclock.example.test/api/timeclock/integrations/owner-staging/verify-pin');
  assert.equal(calls[1].url,'https://timeclock.example.test/api/timeclock/integrations/owner-staging/authorize');
  assert.equal(calls[0].headers['x-owner-staging-service-secret'],
    'owner-service-dedicated-secret-0123456789');
  assert.equal(calls[0].headers['x-scanner-service-secret'],undefined);
  assert.deepEqual(calls[1].body,{employeeId:42});
});
test('default Scanner adapter path remains unchanged',async()=>{
  const calls=[];
  const identity=createTimeclockScannerIdentity({
    baseUrl:'https://timeclock.example.test',
    serviceSecret:'scanner-service-secret-012345678901',
    fetchImpl:async(url,options)=>{
      calls.push({url:String(url),headers:options.headers});
      return {ok:true,json:async()=>({employee})};
    }
  });
  await identity.verifyPin('1234');
  assert.match(calls[0].url,/\/scanner\/verify-pin$/);
  assert.equal(calls[0].headers['x-scanner-service-secret'],
    'scanner-service-secret-012345678901');
  assert.equal(calls[0].headers['x-owner-staging-service-secret'],undefined);
  assert.throws(()=>createTimeclockScannerIdentity({
    baseUrl:'https://timeclock.example.test',serviceSecret:'x'.repeat(32),
    mode:'other'
  }),/Invalid Timeclock integration mode/);
});
