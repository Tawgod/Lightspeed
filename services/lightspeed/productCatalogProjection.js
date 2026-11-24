import { inspectTypedProductIdentity } from './productIdentity.js';
import { inspectSupplierProductLinks, inspectCatalogPrices, inspectCatalogReferences, inspectProductAssets } from './catalog.js';

// Internal composition over normalized offline evidence. This is NOT a
// public API envelope, permission check, vendor reader or write preflight.
const text = v => typeof v==='string' && v.length<=256 && v.trim().length>0 && !/[\u0000-\u001f\u007f]/u.test(v);
const sameTarget=(a,b)=>a?.productId===b.productId&&a?.variantId===b.variantId;
const lists=['suppliers','brands','manufacturers','departments','categories','tags'];
const scopeKeys=['identity','supplierLinks','prices','references','assets'];
const targetValid=t=>text(t?.productId)&&(t.variantId===null||text(t.variantId));

export function projectCatalogConsumerView(target, snapshot, {approvedHosts=[]}={}) {
  if(!targetValid(target)||!snapshot||typeof snapshot!=='object')
    throw new TypeError('Explicit target and normalized evidence snapshot required.');
  const issues=[];
  const rows=key=>{
    if(!Array.isArray(snapshot[key])){issues.push({section:key,code:'MISSING_EVIDENCE'});return [];}
    return snapshot[key];
  };
  const coverage=key=>snapshot.coverage?.[key]===true;
  const identities=rows('identity'), targetRows=identities.filter(r=>sameTarget(r,target));
  // Do not infer a product from a link, price or image. Require an explicit
  // observation of the requested target; activity/name conflicts stay unknown.
  const observed=targetRows.length>0;
  const names=new Set(), activities=new Set(), queries=new Map();
  let identityValid=observed;
  for(const row of targetRows){
    if(!text(row.name)||![true,false,null].includes(row.active)||!Array.isArray(row.identifiers)){
      identityValid=false;continue;
    }
    names.add(row.name);activities.add(row.active);
    for(const item of row.identifiers){
      const q={kind:item?.kind,exactValue:item?.exactValue,
        supplierId:item?.supplierId??null,manufacturerId:item?.manufacturerId??null};
      queries.set(JSON.stringify(q),q);
    }
  }
  if(names.size!==1||activities.size!==1)identityValid=false;
  const identityMatches=[];
  for(const q of queries.values()){
    try{
      const result=inspectTypedProductIdentity(q,identities,{complete:coverage('identity')});
      identityMatches.push({query:q,result});
      if(!result.complete||result.status!=='EXACT_UNIQUE'||!sameTarget(result.candidates[0],target))
        identityValid=false;
    }catch(e){
      if(!(e instanceof TypeError))throw e;
      identityValid=false;issues.push({section:'identity',code:'INVALID_IDENTIFIER'});
    }
  }
  // No identifiers is valid display evidence but not a complete identity claim.
  if(!queries.size)identityValid=false;
  if(!observed)issues.push({section:'identity',code:'TARGET_NOT_OBSERVED'});
  if(!identityValid)issues.push({section:'identity',code:'IDENTITY_UNRESOLVED'});
  const links=inspectSupplierProductLinks(target,rows('supplierLinks'),{complete:coverage('supplierLinks')});
  const prices=inspectCatalogPrices(target,rows('prices'),{complete:coverage('prices')});
  const refs=inspectCatalogReferences(snapshot.references,{complete:coverage('references')});
  const assets=inspectProductAssets(target,rows('assets'),{complete:coverage('assets'),approvedHosts});
  // No raw payload pass-through. Only exact explicit references are projected;
  // unknown and unresolved associations are not guessed from display names.
  const refIds={};
  const targetRefRows=targetRows.filter(r=>r.referenceIds&&typeof r.referenceIds==='object');
  for(const kind of lists){
    const values=new Set();
    let valid=targetRefRows.length===targetRows.length&&targetRows.length>0;
    for(const row of targetRefRows){
      const ids=row.referenceIds[kind];
      if(!Array.isArray(ids)||ids.some(id=>!text(id))||new Set(ids).size!==ids.length){valid=false;continue;}
      values.add(JSON.stringify([...ids].sort()));
    }
    if(values.size!==1)valid=false;
    const ids=valid?JSON.parse([...values][0]):null;
    if(ids&&ids.some(id=>!refs.references[kind].some(r=>r.id===id)))valid=false;
    refIds[kind]=valid?ids:null;
    if(!valid)issues.push({section:'references',code:'UNRESOLVED_TARGET_REFERENCES',kind});
  }
  const supplierIds=new Set(refs.references.suppliers.map(r=>r.id));
  if(links.links.some(l=>!supplierIds.has(l.supplierId))||
     prices.prices.some(p=>p.supplierId!==null&&!supplierIds.has(p.supplierId)))
    issues.push({section:'references',code:'UNRESOLVED_SUPPLIER_REFERENCE'});
  const sections={identity:coverage('identity')&&identityValid,
    supplierLinks:links.complete,prices:prices.complete,references:refs.complete,
    assets:assets.complete};
  // References are not fetch instructions. Exclude URLs, opaque storage IDs,
  // raw evidence and cost observations from this minimal display projection.
  const complete=scopeKeys.every(k=>sections[k])&&issues.length===0;
  return {target:{productId:target.productId,variantId:target.variantId},
    observed,complete,coverage:sections,issues,
    product:observed?{name:names.size===1?[...names][0]:null,
      active:activities.size===1?[...activities][0]:null,
      identifiers:identityMatches.map(({query,result})=>({kind:query.kind,
        exactValue:query.exactValue,supplierId:query.supplierId,manufacturerId:query.manufacturerId,
        status:result.status})),referenceIds:refIds}:null,
    supplierLinks:links.links.map(l=>({supplierId:l.supplierId,supplierSku:l.supplierSku,primary:l.primary})),
    primarySupplierId:links.complete&&refs.complete&&supplierIds.has(links.primarySupplierId)?links.primarySupplierId:null,
    prices:prices.prices.map(p=>({kind:p.kind,amount:p.amount,currency:p.currency,supplierId:p.supplierId,outletId:p.outletId})),
    assets:assets.assets.map(a=>({assetId:a.assetId,kind:a.metadata?.kind??null,
      role:a.metadata?.role??null,slot:a.metadata?.slot??null,availability:a.metadata?.availability??'UNKNOWN'})),
    primaryImageId:assets.primaryImageId,
    diagnostics:{identity:identityMatches.map(({query,result})=>({kind:query.kind,status:result.status,issues:result.issues})),
      supplierLinks:links.issues,prices:prices.issues,references:refs.issues,assets:assets.issues}};
}
