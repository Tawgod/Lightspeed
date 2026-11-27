// Offline trusted normalized evidence only. No authority, vendor I/O, writes or routes.
export function createJanuaryCatalogLookup(snapshot) {
 const kinds=['STORE_TAG','SKU','UPC','EAN','ISBN','GTIN','SUPPLIER_SKU','MANUFACTURER_PART','ALIAS','CUSTOM','ITF','JAN'];
 const text=v=>typeof v==='string'&&v.length<=256&&v.trim().length>0&&!/[\u0000-\u001f\u007f]/u.test(v);
 const scopeKeys=['tenant','environment','location','sourceRef','revision'];
 if(!snapshot||!scopeKeys.every(k=>text(snapshot[k]))||!Array.isArray(snapshot.records))throw new TypeError('Trusted scoped snapshot required');
 const scope=Object.freeze(Object.fromEntries(scopeKeys.map(k=>[k,snapshot[k]])));
 const targetComplete=snapshot.coverage?.TARGET===true;
 const coverage=new Set(kinds.filter(k=>snapshot.coverage?.[k]===true)), nameComplete=snapshot.coverage?.NAME===true;
 const index=new Map(), targets=new Map(), uncertain=new Set(); let malformed=false;
 for(const row of snapshot.records){
  if(!row||!text(row.productId)||!Object.hasOwn(row,'variantId')||!(row.variantId===null||text(row.variantId))||row.variantVerified!==true||!text(row.name)||typeof row.active!=='boolean'||!Array.isArray(row.identifiers)){malformed=true;continue}
  const key=JSON.stringify([row.productId,row.variantId]), target=Object.freeze({productId:row.productId,variantId:row.variantId,name:row.name,active:row.active});
  const prior=targets.get(key);if(prior&&(prior.name!==target.name||prior.active!==target.active)){malformed=true;continue}targets.set(key,target);
  for(const id of row.identifiers){
   if(!id||!kinds.includes(id.kind)||!text(id.value)||!text(id.provenance)||typeof id.verified!=='boolean'||(id.kind==='SUPPLIER_SKU'?!text(id.supplierId):id.supplierId!=null)||(id.kind==='MANUFACTURER_PART'?!text(id.manufacturerId):id.manufacturerId!=null)){malformed=true;continue}
   if(!id.verified){uncertain.add(id.value);continue}
   const entries=index.get(id.value)||[];entries.push(Object.freeze({key,kind:id.kind,supplierId:id.supplierId??null,manufacturerId:id.manufacturerId??null}));index.set(id.value,entries);
  }
 }
 const scoped=q=>scopeKeys.every(k=>q?.[k]===scope[k]);
 const result=(status,complete,candidates)=>({status,complete,scope:{...scope},candidates:candidates.map(x=>({...x}))});
 function resolve(q){
  if(!scoped(q)||!text(q.value)||(q.kind!=null&&!kinds.includes(q.kind))||(q.supplierId!=null&&(!text(q.supplierId)||q.kind!=='SUPPLIER_SKU'))||(q.manufacturerId!=null&&(!text(q.manufacturerId)||q.kind!=='MANUFACTURER_PART')))throw new TypeError('Exact query and snapshot scope required');
  const found=(index.get(q.value)||[]).filter(e=>(q.kind==null||e.kind===q.kind)&&(q.supplierId==null||e.supplierId===q.supplierId)&&(q.manufacturerId==null||e.manufacturerId===q.manufacturerId));
  const candidates=[...new Set(found.map(e=>e.key))].sort().map(k=>targets.get(k));
  const complete=!malformed&&!uncertain.has(q.value)&&(q.kind==null?kinds.every(k=>coverage.has(k)):coverage.has(q.kind));
  return result(candidates.length>1?'AMBIGUOUS':!complete?'INCOMPLETE':candidates.length?'EXACT_UNIQUE':'NO_MATCH',complete,candidates);
 }
 function searchName(q){
  if(!scoped(q)||!text(q.name)||!Number.isInteger(q.limit)||q.limit<1||q.limit>100)throw new TypeError('Scoped name query and limit required');
  const matches=[...targets.values()].filter(t=>t.name.toLowerCase().includes(q.name.toLowerCase())).sort((a,b)=>{const x=JSON.stringify([a.productId,a.variantId]),y=JSON.stringify([b.productId,b.variantId]);return x<y?-1:x>y?1:0});
  const complete=nameComplete&&!malformed&&matches.length<=q.limit;
  return result(!complete?'INCOMPLETE':matches.length?'CANDIDATES':'NO_MATCH',complete,matches.slice(0,q.limit));
 }
 // Exact selected target, not an identifier or name search. TARGET coverage is
 // independent proof of complete canonical member mapping for this snapshot.
 function verifySelection(q){
  if(!scoped(q)||!text(q.productId)||!Object.hasOwn(q,'variantId')||!(q.variantId===null||text(q.variantId)))throw new TypeError('Exact selected target and snapshot scope required');
  const target=targets.get(JSON.stringify([q.productId,q.variantId]));
  const complete=targetComplete&&!malformed;
  return result(!complete?'INCOMPLETE':target?'EXACT_UNIQUE':'NO_MATCH',complete,target?[target]:[]);
 }
 return Object.freeze({resolve,searchName,verifySelection});
}
