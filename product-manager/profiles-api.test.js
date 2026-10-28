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
