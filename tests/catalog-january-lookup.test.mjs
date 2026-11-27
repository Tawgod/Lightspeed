import assert from 'node:assert/strict';
import test from 'node:test';
import {createJanuaryCatalogLookup} from '../services/lightspeed/catalogJanuaryLookup.js';
function januaryLookupChecks(create,assert){
 const kinds=['STORE_TAG','SKU','UPC','EAN','ISBN','GTIN','SUPPLIER_SKU','MANUFACTURER_PART','ALIAS'];
 const scope={tenant:'fictional',environment:'test',location:'outlet-001',sourceRef:'catalog-fictional',revision:'r1'};
 const id=(kind,value,extra={})=>({kind,value,provenance:'fictional-verified-map',verified:true,...extra});
 const row=(productId,identifiers,extra={})=>({productId,variantId:null,variantVerified:true,name:'Fictional model kit',active:true,identifiers,...extra});
 const original=row('000701',kinds.map((kind,i)=>id(kind,i===0?'000701':`000${i}`,kind==='SUPPLIER_SKU'?{supplierId:'S1'}:kind==='MANUFACTURER_PART'?{manufacturerId:'M1'}:{})));
 const snapshot=(records=[original],coverage=Object.fromEntries([...kinds,'NAME'].map(k=>[k,true])))=>({...scope,records,coverage});
 const resolve=(s,value,extra={})=>create(s).resolve({...scope,value,...extra});
 const check=(label,fn)=>{fn();assert(true,label)};
 check('all nine exact kinds',()=>{for(let i=0;i<kinds.length;i++)assert(resolve(snapshot(),i===0?'000701':`000${i}`).candidates[0]?.productId==='000701',kinds[i])});
 check('leading zeros preserved',()=>assert(resolve(snapshot(),'701').status==='NO_MATCH'));
 check('same target across kinds deduplicates',()=>assert(resolve(snapshot([row('p',[id('SKU','001'),id('UPC','001')])]),'001').candidates.length===1));
 check('cross-kind collision',()=>assert(resolve(snapshot([row('p',[id('SKU','001')]),row('q',[id('UPC','001')])]),'001').status==='AMBIGUOUS'));
 check('same parent different variants',()=>assert(resolve(snapshot([row('p',[id('SKU','001')],{variantId:'v1'}),row('p',[id('SKU','001')],{variantId:'v2'})]),'001').status==='AMBIGUOUS'));
 check('supplier scope',()=>{const s=snapshot([row('p',[id('SUPPLIER_SKU','001',{supplierId:'S1'})]),row('q',[id('SUPPLIER_SKU','001',{supplierId:'S2'})])]);assert(resolve(s,'001').status==='AMBIGUOUS');assert(resolve(s,'001',{kind:'SUPPLIER_SKU',supplierId:'S1'}).candidates[0].productId==='p')});
 check('incomplete coverage cannot establish absence or uniqueness',()=>{const s=snapshot([original],{SKU:true});assert(resolve(s,'000701').status==='INCOMPLETE');assert(resolve(s,'absent').status==='INCOMPLETE')});
 check('typed complete lookup',()=>assert(resolve(snapshot([original],{SKU:true}),'0001',{kind:'SKU'}).status==='EXACT_UNIQUE'));
 check('unverified alias blocks uniqueness',()=>assert(resolve(snapshot([original,row('q',[id('ALIAS','000701',{verified:false})])]),'000701').status==='INCOMPLETE'));
 check('variant absence requires independent assertion',()=>assert(resolve(snapshot([row('p',[id('SKU','001')],{variantVerified:false})]),'001').status==='INCOMPLETE'));
 check('conflicting record names',()=>assert(resolve(snapshot([original,{...original,name:'Other'}]),'000701').status==='INCOMPLETE'));
 check('inactive collision retained',()=>assert(resolve(snapshot([original,row('q',[id('SKU','000701')],{active:false})]),'000701').status==='AMBIGUOUS'));
 check('scope rejection',()=>{let rejected=false;try{resolve(snapshot(),'000701',{revision:'r2'})}catch{rejected=true}assert(rejected)});
 check('numeric input rejected',()=>{let rejected=false;try{resolve(snapshot(),701)}catch{rejected=true}assert(rejected)});
 check('no punctuation or case normalization',()=>assert(resolve(snapshot([row('p',[id('SKU','Ab-01')])]),'ab01').status==='NO_MATCH'));
 check('name search never exact',()=>assert(create(snapshot()).searchName({...scope,name:'MODEL',limit:10}).status==='CANDIDATES'));
 check('bounded name search incomplete on truncation',()=>assert(create(snapshot([original,row('q',[])])).searchName({...scope,name:'model',limit:1}).status==='INCOMPLETE'));
 check('snapshot and output mutation isolated',()=>{const s=snapshot([row('p',[id('SKU','001')])]);const lookup=create(s);s.records[0].name='changed';const a=lookup.resolve({...scope,value:'001'});a.candidates[0].name='tamper';assert(lookup.resolve({...scope,value:'001'}).candidates[0].name==='Fictional model kit')});
}
test('January exact lookup contract: 18 named cases',()=>januaryLookupChecks(createJanuaryCatalogLookup,(v,label)=>assert.ok(v,label)));

test('exact selected target requires independent TARGET coverage',()=>{
 const scope={tenant:'fictional',environment:'test',location:'outlet-001',sourceRef:'fixture',revision:'r1'};
 const row={productId:'000701',variantId:null,variantVerified:true,name:'Fictional model kit',active:true,identifiers:[]};
 const snapshot={...scope,coverage:{TARGET:true,NAME:true},records:[row,{...row,variantId:'blue',name:'Blue kit'}]};
 const q={...scope,productId:'000701',variantId:null},lookup=createJanuaryCatalogLookup(snapshot);
 assert.equal(lookup.verifySelection(q).status,'EXACT_UNIQUE');
 assert.equal(lookup.verifySelection({...q,variantId:'blue'}).candidates[0].name,'Blue kit');
 assert.equal(lookup.verifySelection({...q,variantId:'missing'}).status,'NO_MATCH');
 assert.equal(createJanuaryCatalogLookup({...snapshot,coverage:{NAME:true}}).verifySelection(q).status,'INCOMPLETE');
 assert.equal(createJanuaryCatalogLookup({...snapshot,records:[row,{...row,name:'conflict'}]}).verifySelection(q).status,'INCOMPLETE');
 assert.equal(lookup.searchName({...scope,name:'kit',limit:10}).status,'CANDIDATES');
 assert.throws(()=>lookup.verifySelection({...q,revision:'r2'}));
 assert.throws(()=>lookup.verifySelection({...scope,productId:'000701'}));
 assert.throws(()=>lookup.verifySelection({...q,productId:701}));
});
