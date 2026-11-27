// Isolated fixture helpers only. No authentication, provider or persistence contract.
import {buildLabelPrintRequest} from './label-print-request.mjs';
import {createJanuaryCatalogLookup} from './catalogJanuaryLookup.mjs';
export const fixtureRoles=Object.freeze({Alex:'bulk',Morgan:'individual',Taylor:'read'});
export const editFields=new Set(['name','upc','brand','category','supplier','supplierSku','cost','price','description','tags','itemOnline']);
export const bulkFields=new Set([...editFields].filter(f=>!['upc','supplierSku'].includes(f)));
export function canEdit(role,mode){return (mode==='individual'||mode==='bulk')&&(role==='bulk'||(role==='individual'&&mode==='individual'))}
const exactText=v=>typeof v==='string'&&v.length<=256&&v.trim().length>0&&!/[\u0000-\u001f\u007f]/u.test(v);
const validIdentity=p=>p&&exactText(p.productId)&&Object.hasOwn(p,'variantId')&&(p.variantId===null||exactText(p.variantId))&&p.variantVerified===true;
// Adapt fictional records to the pinned shared Catalog resolver. No live coverage claim.
export function exactLookup(products,code){
 if(!exactText(code))return {status:'invalid',matches:[]};
 const scope={tenant:'fictional',environment:'test',location:'fixture-outlet',sourceRef:'fixture-catalog',revision:'fixture-r1'};
 const kinds=['STORE_TAG','SKU','UPC','EAN','ISBN','GTIN','SUPPLIER_SKU','MANUFACTURER_PART','ALIAS','NAME'];
 const make=(kind,value,extra={})=>({kind,value,verified:true,provenance:'fictional-fixture',...extra});
 const records=products.map(p=>({productId:p.productId,variantId:p.variantId,variantVerified:p.variantVerified,name:p.name,active:p.active,identifiers:[
  ...[['STORE_TAG',p.storeTag],['SKU',p.sku],['UPC',p.upc],['EAN',p.ean],['ISBN',p.isbn],['GTIN',p.gtin],['ALIAS',p.alias]].filter(([,v])=>v!==undefined&&v!=='').map(([k,v])=>make(k,v)),
  ...(p.supplierSku?[make('SUPPLIER_SKU',p.supplierSku,{supplierId:p.supplierId})]:[]),
  ...(p.manufacturerCode?[make('MANUFACTURER_PART',p.manufacturerCode,{manufacturerId:p.manufacturerId})]:[])
 ]}));
 try{
  const r=createJanuaryCatalogLookup({...scope,records,coverage:Object.fromEntries(kinds.map(k=>[k,true]))}).resolve({...scope,value:code});
  const matches=r.candidates.flatMap(c=>products.filter(p=>p.productId===c.productId&&p.variantId===c.variantId));
  const status={EXACT_UNIQUE:'matched',AMBIGUOUS:'ambiguous',NO_MATCH:'unmatched',INCOMPLETE:'incomplete'}[r.status]||'incomplete';
  return {status:status==='matched'&&matches.length!==1?'incomplete':status,matches};
 }catch{return {status:'incomplete',matches:[]}}
}
export function parseValue(f,raw){
 if(!f?.editable||!editFields.has(f.id))throw Error('Field not enabled in January fixture');
 if(f.kind==='boolean'){if(![true,false,'true','false'].includes(raw))throw Error('Expected Yes or No');return raw===true||raw==='true'}
 if(f.id==='price'||f.id==='cost'){const s=String(raw);if(!/^\d+(?:\.\d{1,2})?$/.test(s)||!Number.isSafeInteger(Math.round(Number(s)*100)))throw Error('Enter nonnegative currency with up to two decimal places');return Number(s)}
 if(typeof raw!=='string')throw Error('Expected text');
 if(f.id==='name'&&!exactText(raw))throw Error('Valid product name required');
 if(['upc','supplierSku'].includes(f.id)&&raw!==''&&!exactText(raw))throw Error('Valid exact identifier required');
 return raw;
}
export function snapshotChanges(products,drafts,modes,role,field){
 const result=[];
 for(const [key,to] of Object.entries(drafts)){
  const [sku,id]=key.split('|'), matches=products.filter(p=>p.sku===sku),p=matches[0],mode=modes[key]||'individual';
  if(matches.length!==1||!validIdentity(p))throw Error('Unresolved product identity');
  if(!canEdit(role,mode)||(mode==='bulk'&&!bulkFields.has(id)))throw Error('Edit permission required');
  const next=parseValue(field(id),to);if(Object.is(p[id],next))continue;
  result.push({key,sku,productId:p.productId,variantId:p.variantId,id,old:p[id],to:next,mode});
 }
 if(new Set(result.map(c=>JSON.stringify([c.productId,c.variantId,c.id]))).size!==result.length)throw Error('Duplicate target');
 for(const c of result.filter(c=>c.id==='upc'&&c.to!=='')){if(products.some(p=>p.productId!==c.productId||p.variantId!==c.variantId ? p.upc===c.to : false)||result.some(other=>other!==c&&other.id==='upc'&&other.to===c.to))throw Error('Duplicate UPC; review manually')}
 return structuredClone(result);
}
export function applyFixture(products,review,role,field,{failSku=''}={}){
 const groups=new Map(),results=[];
 for(const c of review){const k=JSON.stringify([c.productId,c.variantId]);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(c)}
 for(const changes of groups.values()){
  const first=changes[0],matches=products.filter(p=>p.productId===first.productId&&p.variantId===first.variantId),p=matches[0];
  try{
   if(matches.length!==1||!validIdentity(p)||p.sku!==first.sku)throw Error('Identity conflict');
   if(new Set(changes.map(c=>c.id)).size!==changes.length)throw Error('Duplicate reviewed field');
   if(first.sku===failSku)throw Error('Simulated failure before write');
   for(const c of changes){if(c.sku!==p.sku||!canEdit(role,c.mode)||(c.mode==='bulk'&&!bulkFields.has(c.id)))throw Error('Permission denied');if(!Object.is(parseValue(field(c.id),c.to),c.to))throw Error('Invalid reviewed value');if(c.id==='upc'&&c.to!==''&&products.some(other=>other!==p&&other.upc===c.to))throw Error('Duplicate UPC; review manually');if(!Object.is(p[c.id],c.old))throw Error('Stale value; review again')}
   for(const c of changes)p[c.id]=c.to;
   if(changes.some(c=>!Object.is(p[c.id],c.to)))throw Error('Fixture readback mismatch');
   results.push({sku:p.sku,status:'applied',keys:changes.map(c=>c.key)});
  }catch(e){results.push({sku:first.sku,status:'failed',reason:e.message,keys:[]})}
 }
 return results;
}
export function prepareSelectedLabels(products,selected,{qty=1,startRow=1,startCol=1}={}){
 if(!Number.isSafeInteger(qty)||qty<1)throw Error('Choose at least one label per item');
 const items=[...selected].map(sku=>{const matches=products.filter(p=>p.sku===sku),p=matches[0];if(matches.length!==1||!validIdentity(p)||typeof p.price!=='number'||!Number.isFinite(p.price)||p.price<0)throw Error('Current product identity and price required');return {sku:p.sku,name:p.name,price:'$'+p.price.toFixed(2),qty}});
 return buildLabelPrintRequest({sourceId:'SELECTED_PRODUCTS',startRow,startCol,items});
}
