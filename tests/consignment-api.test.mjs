import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createConsignmentBetaRouter,validateSubmission} from '../routes/consignmentBeta.js';

const base={customer:{display_name:'Sample Buyer',email:'demo@example.invalid',phone:'555-0100'},items:[{item_type:'Game',name:'Sample game',price:12.5,condition:'Good',inspection:{missing_status:'inventoried',smoking:'No',basement_smell:'No',pets:['None']}}]};
test('intake rejects incomplete mechanical and household records',()=>{
 assert.equal(validateSubmission(base).items.length,1);
 assert.throws(()=>validateSubmission({...base,items:[{...base.items[0],item_type:'Train'}]}),/Mechanical test status/);
 assert.throws(()=>validateSubmission({...base,items:[{...base.items[0],inspection:{...base.items[0].inspection,missing_status:'missing'}}]}),/Missing parts/);
});
test('unconfigured API does not expose submissions or allow writes',async()=>{
 const app=express();app.use(express.json());app.use('/api/consignment-beta',createConsignmentBetaRouter());
 const server=app.listen(0);
 try{
  const url='http://127.0.0.1:'+server.address().port+'/api/consignment-beta';
  const r=await fetch(url+'/submissions');
  assert.equal(r.status,503);
  const w=await fetch(url+'/submissions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(base)});
  assert.equal(w.status,503);
 }finally{server.close();}
});
test('configured API requires key and refuses writes by default',async()=>{
 const pool={query:async()=>({rows:[]})};
 const app=express();app.use(express.json());app.use('/api/consignment-beta',createConsignmentBetaRouter({pool,staffKey:'test-staff-secret'}));
 const server=app.listen(0);
 try{
  const url='http://127.0.0.1:'+server.address().port+'/api/consignment-beta';
  assert.equal((await fetch(url+'/submissions')).status,401);
  assert.equal((await fetch(url+'/submissions',{headers:{'x-consignment-staff-key':'invalid'}})).status,401);
  assert.equal((await fetch(url+'/health',{headers:{'x-consignment-staff-key':'test-staff-secret'}})).status,200);
  assert.equal((await fetch(url+'/submissions',{method:'POST',headers:{'x-consignment-staff-key':'test-staff-secret','Content-Type':'application/json'},body:JSON.stringify(base)})).status,423);
 }finally{server.close();}
});
