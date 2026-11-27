import test from 'node:test';
import assert from 'node:assert/strict';
import {createHcSecureIdentityProvider,isCanonicalEmployeeId} from '../hcSecureIdentity.js';
const id='9223372036854775807';
const env={HC_SECURE_IDENTITY_ENABLED:'true',HC_SECURE_IDENTITY_EMPLOYEE_ID:id,
  HC_SECURE_IDENTITY_SERVICE_SECRET:'a'.repeat(40),HC_SECURE_IDENTITY_THROTTLE_SECRET:'b'.repeat(40),
  HC_SECURE_IDENTITY_AUDIENCE:'fictional-test'};
const request={operation:'verify-pin',body:{employeeId:id,pin:'1234'},credential:env.HC_SECURE_IDENTITY_SERVICE_SECRET,
  audience:env.HC_SECURE_IDENTITY_AUDIENCE,transport:{fictional:true},browserOrigin:false};
function setup({environment=env,reservation=true,active=true,transport=true,fail=false,rowId=id}={}) {
  const calls=[];
  const pool={query:async q=>{calls.push(q);if(fail)throw Error('fictional failure');
    return q.text.startsWith('INSERT')?{rowCount:1,rows:[{admitted:reservation}]}:{rowCount:1,rows:[{id:rowId,active}]};}};
  return {calls,provider:createHcSecureIdentityProvider({pool,environment,pinHash:p=>`fixture:${p}`,
    verifyTransport:async()=>transport})};
}
test('canonical BIGSERIAL decimal string, no numeric coercion',()=>{
  for(const v of ['1','9007199254740993',id])assert.equal(isCanonicalEmployeeId(v),true);
  for(const v of [1,'0','01','-1',' 1','1e2','9223372036854775808',null])assert.equal(isCanonicalEmployeeId(v),false);
});
test('selected PIN and current-active lookup return exact minimal identity; reservation precedes lookup',async()=>{
  const {provider,calls}=setup();
  assert.deepEqual(await provider.handle(request),{status:200,body:{employee:{id,active:true,employeeNumber:null}}});
  assert.match(calls[0].text,/ON CONFLICT/);assert.deepEqual(calls[1].values,[id,'fixture:1234']);
  assert.equal(calls[0].values[1],5);
  assert.equal((await provider.handle({...request,operation:'authorize',body:{employeeId:id}})).status,200);
  assert.equal(calls[2].values[1],120);assert.notEqual(calls[0].values[0],calls[2].values[0]);
  assert.deepEqual(calls[3].values,[id]);
});
test('disabled, missing or reused credentials deny before database',async()=>{
  for(const environment of [{},{...env,HC_SECURE_IDENTITY_ENABLED:'false'},
    {...env,SCANNER_SERVICE_SECRET:env.HC_SECURE_IDENTITY_SERVICE_SECRET},
    {...env,HC_SECURE_IDENTITY_THROTTLE_SECRET:env.HC_SECURE_IDENTITY_SERVICE_SECRET},
    {...env,HC_SECURE_IDENTITY_EMPLOYEE_ID:'901'}]) {
    const {provider,calls}=setup({environment});assert.equal((await provider.handle(request)).status,403);assert.equal(calls.length,0);
  }
});
test('wrong credential, audience, browser, selected ID, malformed body and operation deny without query',async()=>{
  const {provider,calls}=setup();
  for(const patch of [{credential:'wrong'},{audience:'other'},{browserOrigin:true},{browserOrigin:undefined},
    {body:{employeeId:'42',pin:'1234'}},{body:{employeeId:id,pin:1234}},
    {body:{employeeId:id,pin:'1234',role:'owner'}},{operation:'unknown'}])
    assert.equal((await provider.handle({...request,...patch})).status,403);
  assert.equal(calls.length,0);
});
test('transport, throttle, database, inactive and mismatched identity fail closed',async()=>{
  for(const [options,n] of [[{transport:false},0],[{transport:1},0],[{reservation:false},1],
    [{reservation:1},1],[{fail:true},1],[{active:false},2],[{rowId:'42'},2]]) {
    const {provider,calls}=setup(options);assert.deepEqual(await provider.handle(request),{status:403,body:{error:'Employee verification denied.'}});assert.equal(calls.length,n);
  }
});
test('deadline denies and does not begin lookup after a delayed transport result',async()=>{
  const calls=[];let finish;
  const provider=createHcSecureIdentityProvider({environment:env,pinHash:x=>x,
    pool:{query:async q=>{calls.push(q);throw Error('must not run');}},
    verifyTransport:()=>new Promise(resolve=>{finish=resolve;})});
  assert.equal((await provider.handle(request)).status,403);finish(true);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(calls.length,0);
});

const multiEnv={...env,HC_SECURE_IDENTITY_EMPLOYEE_ID:undefined,HC_SECURE_IDENTITY_EMPLOYEE_IDS:JSON.stringify([id,'42'])};
test('multiple eligible employees retain exact identity and independent reservation scope',async()=>{
  const calls=[];
  const provider=createHcSecureIdentityProvider({environment:multiEnv,pinHash:p=>`fixture:${p}`,verifyTransport:async()=>true,
    pool:{query:async q=>{calls.push(q);return q.text.startsWith('INSERT')?{rowCount:1,rows:[{admitted:true}]}:{rowCount:1,rows:[{id:q.values[0],active:true}]};}}});
  for(const selected of [id,'42'])assert.deepEqual((await provider.handle({...request,body:{employeeId:selected,pin:'1234'}})).body,{employee:{id:selected,active:true,employeeNumber:null}});
  assert.notEqual(calls[0].values[0],calls[2].values[0]);
  assert.deepEqual(calls[1].values,[id,'fixture:1234']);assert.deepEqual(calls[3].values,['42','fixture:1234']);
  for(const selected of ['43',42,'042','901'])assert.equal((await provider.handle({...request,body:{employeeId:selected,pin:'1234'}})).status,403);
  assert.equal(calls.length,4);
});
test('invalid or conflicting eligibility configuration denies before database',async()=>{
  for(const value of ['[]','null','"42"','[42]','["42","42"]','["901"]','["042"]','broken',JSON.stringify(Array.from({length:101},(_,i)=>String(i+1)))]){
    const {provider,calls}=setup({environment:{...multiEnv,HC_SECURE_IDENTITY_EMPLOYEE_IDS:value}});
    assert.equal((await provider.handle(request)).status,403);assert.equal(calls.length,0);
  }
  const {provider,calls}=setup({environment:{...multiEnv,HC_SECURE_IDENTITY_EMPLOYEE_ID:id}});
  assert.equal((await provider.handle(request)).status,403);assert.equal(calls.length,0);
});
test('eligible employee still needs current active exact identity and trusted transport',async()=>{
  const selected={...request,operation:'authorize',body:{employeeId:'42'}};
  for(const options of [{rowId:'42',active:false},{rowId:id},{rowId:'42',transport:false}]){
    const {provider}=setup({environment:multiEnv,...options});assert.equal((await provider.handle(selected)).status,403);
  }
  const {provider}=setup({environment:multiEnv,rowId:'42'});assert.equal((await provider.handle(selected)).status,200);
});
