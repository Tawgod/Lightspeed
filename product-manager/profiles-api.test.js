import test from 'node:test';import assert from 'node:assert/strict';
import {validateProfileConfig,createProductManagerProfilesRouter} from './profiles-api.js';
test('Profiles validate list identity, limits, widths and permitted keys',()=>{
 assert.equal(validateProfileConfig({columns:['sku','name'],widths:{sku:120},detailsOrder:['name']}),true);
 for(const c of [{columns:['sku','sku']},{widths:{sku:0}},{widths:{sku:5000}},{admin:true},{columns:'SKU'},null])assert.equal(validateProfileConfig(c),false);
});
test('Profiles require staff authentication and database',()=>{
 assert.throws(()=>createProductManagerProfilesRouter({pool:{query:()=>{} }}));
 assert.throws(()=>createProductManagerProfilesRouter({verifyEmployee:()=>({id:1})}));
});

test('Work backups reject malformed and excessive staged edits',async()=>{
 const {validateWorkDraft}=await import('./profiles-api.js');
 const valid={changes:[{productId:'a',field:'name',oldValue:'Old',newValue:'New'}],
   layout:{columns:['sku','name'],hidden:[],widths:{},detailsOrder:[]},
   slot:'Profile 1',selection:'a',filter:'0000123',savedAt:Date.now()};
 assert.equal(validateWorkDraft(valid),true);
 assert.equal(validateWorkDraft({...valid,slot:'Other'}),false);
 assert.equal(validateWorkDraft({...valid,changes:[{...valid.changes[0],employeeId:7}]}),false);
 assert.equal(validateWorkDraft({...valid,changes:Array(251).fill(valid.changes[0])}),false);
});
