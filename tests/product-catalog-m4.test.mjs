import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectProductAssets} from '../services/lightspeed/catalog.js';
const target={productId:'000P',variantId:null};
const opts={complete:true,approvedHosts:['media.example.com']};
const asset=(assetId,over={})=>({...target,assetId,kind:'IMAGE',role:'GALLERY',slot:1,
 availability:'AVAILABLE',reference:{kind:'STORAGE_ID',value:assetId},source:'fixture',
 provenance:'row-1',observedAt:'2026-11-24T10:00:00.000Z',...over});
test('ordered image slots and explicit primary survive projection',()=>{
 const r=inspectProductAssets(target,[asset('B',{slot:2}),asset('A',{slot:0,role:'PRIMARY'})],opts);
 assert.deepEqual(r.assets.map(x=>x.assetId),['A','B']);assert.equal(r.primaryImageId,'A');assert.equal(r.complete,true);
});
test('variant assets are not inherited or mixed with parent assets',()=>{
 const rows=[asset('P',{role:'PRIMARY'}),asset('V',{variantId:'000V',role:'PRIMARY'})];
 assert.equal(inspectProductAssets({...target,variantId:'000V'},rows,opts).primaryImageId,'V');
 assert.equal(inspectProductAssets(target,rows,opts).primaryImageId,'P');
});
test('manuals and Drive file references are opaque, not fetched',()=>{
 const r=inspectProductAssets(target,[asset('M',{kind:'MANUAL',role:'SUPPORTING',slot:null,reference:{kind:'DRIVE_FILE',value:'000abc_X'}})],opts);
 assert.equal(r.assets[0].metadata.reference.value,'000abc_X');assert.equal(r.primaryImageId,null);
});
test('missing and unknown availability are distinct, no fallback primary',()=>{
 const r=inspectProductAssets(target,[asset('A',{role:'PRIMARY',availability:'MISSING',reference:null}),asset('B',{slot:2,availability:'UNKNOWN',reference:null})],opts);
 assert.deepEqual(r.missingAssetIds,['A']);assert.equal(r.primaryImageId,null);assert.equal(r.complete,true);
});
test('multiple primary and duplicate slots or references require review',()=>{
 const r=inspectProductAssets(target,[asset('A',{role:'PRIMARY'}),asset('B',{role:'PRIMARY',reference:{kind:'STORAGE_ID',value:'A'}})],opts);
 assert.equal(r.complete,false);assert.equal(r.primaryImageId,null);
 for(const code of ['MULTIPLE_PRIMARY_IMAGES','DUPLICATE_IMAGE_SLOT','DUPLICATE_ASSET_REFERENCE'])assert.ok(r.issues.includes(code));
});
test('duplicate observations retain provenance, conflicting asset metadata stays unknown',()=>{
 const a=asset('A',{role:'PRIMARY'});
 const r=inspectProductAssets(target,[a,{...a,provenance:'row-2'}],opts);
 assert.equal(r.assets[0].observations.length,2);assert.equal(r.primaryImageId,'A');
 const c=inspectProductAssets(target,[a,{...a,slot:2}],opts);
 assert.equal(c.assets[0].metadata,null);assert.equal(c.complete,false);
});
test('HTTPS reference requires exact approved host and no credential/query/fragment',()=>{
 const good='https://media.example.com/image.png';
 const ref=value=>({kind:'HTTPS_URL',value});
 assert.equal(inspectProductAssets(target,[asset('A',{reference:ref(good)})],opts).complete,true);
 for(const value of ['http://media.example.com/a','https://media.example.com.evil.test/a','https://user:pw@media.example.com/a','https://media.example.com/a?token=secret','https://media.example.com/a#x','https://media.example.com:444/a','javascript:alert(1)','https://media.example.com/a/../b']){
  const r=inspectProductAssets(target,[asset('A',{reference:ref(value)})],opts);assert.equal(r.complete,false);assert.deepEqual(r.assets,[]);
 }
 assert.equal(inspectProductAssets(target,[asset('A',{reference:ref(good)})],{complete:true}).complete,false);
});
test('bad opaque IDs, malformed slots and incomplete evidence fail closed',()=>{
 for(const over of [{reference:{kind:'DRIVE_FILE',value:'../secret'}},{slot:-1},{slot:1.5},{reference:null},{observedAt:'bad'}])
  assert.equal(inspectProductAssets(target,[asset('A',over)],opts).complete,false);
 assert.equal(inspectProductAssets(target,[asset('A',{role:'PRIMARY'})]).primaryImageId,null);
 assert.throws(()=>inspectProductAssets({productId:123,variantId:null},[],opts),TypeError);
});
