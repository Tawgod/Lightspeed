// Consignment match bridge: reuse the exact scanner/Special Orders contract.
// No direct Lightspeed HTTP calls, no credentials, no writes.
import { checkProductMatches } from '../extension/product-scanner/special-orders-adapter.js';

export function isPreviouslyUsedProduct(candidate={}){
 const sku=String(candidate.sku||'').trim().toUpperCase();
 const name=String(candidate.name||'').trim();
 return /^(UG|PZ|RC|US)-\d{6,}$/.test(sku) || /^USED\s*[—:\-]/i.test(name);
}
export function createConsignmentMatcher({lookup}={}){
 if(typeof lookup!=='function')throw new Error('Authenticated Special Orders lookup function required.');
 return async function matchConsignmentItem(item={}){
  const name=String(item.name||item.submitted_name||'').trim();
  if(!name)throw new Error('An item title is required.');
  if(name.length>200)throw new Error('Item title is too long.');
  const code=String(item.original_sku||item.original_upc||'').trim();
  if(code.length>80)throw new Error('Item code is too long.');
  const product={
   name,sku:code,upc:item.original_upc||'',
   description:item.description||'',
  };
  // The shared checkProductMatches implementation FAILS CLOSED if either the
  // local Special Orders lookup or Lightspeed lookup fails or returns bad data.
  const checked=await checkProductMatches(product,lookup);
  return {
   verified:checked.verified,
   candidates:checked.matches.filter(m=>!isPreviouslyUsedProduct(m)).slice(0,15).map(m=>({
    key:m.key,lightspeedId:m.lightspeedId||null,localId:m.localId||null,
    name:m.name,sku:m.sku,brand:m.brand,description:m.description,
    score:m.score,reasons:m.reasons,sources:m.sources,
    // Only references are exposed. Original images must not be copied
    // onto used item records or product-create payloads.
    historicalStatus:'unverified',imagesCopyAllowed:false
   })),
   notes:['Matches are advisory only; staff must select a source product.',
          'Current and historical source item eligibility requires source verification.']
  };
 };
}
