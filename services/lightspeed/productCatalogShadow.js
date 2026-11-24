import {createCoreReadExecutor} from './coreReadContract.js';
import {projectCatalogConsumerView} from './productCatalogProjection.js';
import {inspectTypedProductIdentity} from './productIdentity.js';
import {inspectSupplierProductLinks} from './catalog.js';

// Test-only integration candidate. Operation names below are proposals for
// Security review, not registered grants. Never mount this factory.
const READ='catalog.product.read', COST='catalog.product.cost.read';
const exact=v=>typeof v==='string'&&v.length>0&&v.length<=256&&v.trim()===v&&!/[\x00-\x1f\x7f]/.test(v);
const targetOk=t=>exact(t?.productId)&&(t.variantId===null||exact(t.variantId));
const same=(a,b)=>a?.productId===b.productId&&a?.variantId===b.variantId;

// Do not include internal diagnostics, cost coverage, counts, supplier
// pricing details, provenance, free-text notes, or raw vendor fields.
// Catalog names are plain display text; UI escaping remains required.
function displayView(view, allowCost) {
  const product=view.product;
  const result={
    target:view.target, observed:view.observed,
    product:product?{name:product.name,active:product.active,
      identifiers:product.identifiers.filter(i=>['SKU','UPC','GTIN'].includes(i.kind))
        .map(i=>({kind:i.kind,exactValue:i.exactValue,status:i.status})),
      referenceIds:product.referenceIds}:null,
    coverage:{identity:view.coverage.identity,references:view.coverage.references,assets:view.coverage.assets},
    assets:view.assets.map(a=>({assetId:a.assetId,kind:a.kind,role:a.role,slot:a.slot,availability:a.availability})),
    primaryImageId:view.primaryImageId,
    prices:view.prices.filter(p=>['RETAIL','MSRP'].includes(p.kind)&&p.supplierId===null)
      .map(p=>({kind:p.kind,amount:p.amount,currency:p.currency,outletId:p.outletId}))
  };
  if(allowCost===true)result.costs=view.coverage.prices?view.prices.filter(p=>p.kind==='COST')
    .map(p=>({amount:p.amount,currency:p.currency,supplierId:p.supplierId,outletId:p.outletId})):null;
  return result;
}
export function createCatalogShadowRead({authorizeRead,readSnapshot,approvedHosts=[]}={}) {
  if(typeof authorizeRead!=='function'||typeof readSnapshot!=='function')throw new TypeError('Injected test admission and snapshot reader required.');
  const execute=createCoreReadExecutor({authorizeRead,environment:'test'});
  return async ({target,context}={})=>{
    if(!targetOk(target))throw new TypeError('Exact target required.');
    const safeTarget={productId:target.productId,variantId:target.variantId};
    return execute({operation:READ,context,read:async({correlationId})=>{
      let cost=false;
      try{cost=(await authorizeRead({operation:COST,context,mode:'read',environment:'test',correlationId}))===true;}catch{}
      const snapshot=await readSnapshot({target:safeTarget,correlationId});
      return displayView(projectCatalogConsumerView(safeTarget,snapshot,{approvedHosts}),cost);
    }});
  };
}

// Compare only fields demonstrated in Product Manager PR #28's sample
// interface. Variant, supplier, asset and missing online/description fields
// are explicit coverage gaps, not invented compatibility.
export function compareProductManagerShadow(sample, projected) {
  const differences=[], gaps=[];
  if(!sample||!exact(sample.id)||!projected?.observed||!projected.product||
      projected.target?.variantId!==null||projected.target?.productId!==sample.id){
    return {state:'review',differences:['TARGET'],gaps:[],activationReady:false};
  }
  const product=projected.product;
  const compare=(field,a,b)=>{if(a!==b)differences.push(field);};
  if(projected.coverage?.identity!==true)gaps.push('IDENTITY_COVERAGE');
  compare('name',sample.name,product.name);
  compare('active',sample.active,product.active);
  for(const kind of ['SKU','UPC']){
    const ids=product.identifiers.filter(i=>i.kind===kind&&i.status==='EXACT_UNIQUE');
    const old=sample[kind.toLowerCase()];
    if(ids.length!==1){gaps.push(kind+'_COVERAGE');continue;}
    compare(kind,old,ids[0].exactValue);
  }
  const retail=projected.prices.filter(p=>p.kind==='RETAIL'&&p.currency==='USD'&&p.outletId===null);
  // Old demo uses numbers. Compare only exact safe cents; never round a
  // higher-precision decimal or turn a missing price into zero.
  if(retail.length!==1||typeof retail[0].amount!=='string'||!/^\d{1,12}(?:\.\d{1,2})?$/.test(retail[0].amount)||
     typeof sample.price!=='number'||!Number.isFinite(sample.price)||sample.price<0||
     !Number.isSafeInteger(Math.round(sample.price*100))||
     Number(sample.price.toFixed(2))!==sample.price)gaps.push('RETAIL_COVERAGE');
  else compare('price',sample.price,Number(retail[0].amount));
  for(const field of ['itemOnline','description','supplierLinks','imageLocations'])gaps.push(field);
  return {state:differences.length?'review':'partial_parity',differences,gaps,activationReady:false};
}

// Purchasing P-02 expects product-level verified supplier identity evidence.
// No automatic missing-link proposal, variant collapse, primary reassignment,
// PO selection, receipt or executable decision. Caller supplies immutable
// evidenceRef from trusted fixture storage; not minted by this adapter.
export function projectPurchasingSupplierEvidence({invoiceLineId,supplierId,supplierSku,identityRows,linkRows,
    identityComplete=false,linksComplete=false,evidenceRef}={}) {
  const review=reason=>({state:'needs_review',reason,executable:false});
  if(![invoiceLineId,supplierId,supplierSku,evidenceRef].every(exact)||
    !Array.isArray(identityRows)||!Array.isArray(linkRows))return review('invalid_evidence');
  const result=inspectTypedProductIdentity({kind:'SUPPLIER_SKU',exactValue:supplierSku,supplierId},
    identityRows,{complete:identityComplete});
  if(!result.complete||result.status!=='EXACT_UNIQUE')return review('identity_unresolved');
  const candidate=result.candidates[0];
  if(candidate.variantId!==null||candidate.active!==true||!exact(candidate.productId))return review('target_not_verified_active_product');
  const links=inspectSupplierProductLinks(candidate,linkRows,{complete:linksComplete});
  const match=links.links.filter(l=>l.supplierId===supplierId&&l.supplierSku===supplierSku);
  if(!links.complete||match.length!==1)return review('supplier_link_unresolved');
  return {state:'verified',invoiceLineId,productId:candidate.productId,supplierId,supplierSku,
    relationship:'existing',primarySupplierId:links.primarySupplierId,evidenceRef,executable:false};
}
