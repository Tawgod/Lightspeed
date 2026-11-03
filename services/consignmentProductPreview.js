// Safe preview builder for the existing Special Orders product-creation contract.
// This module performs no Lightspeed API calls. Product creation remains gated.
const CODE=/^(UG|PZ|RC|US)-\d{6,}$/;
const HIDDEN_COPY_FIELDS=Object.freeze([
 'image','image_url','images','photo','pictures','inventory','stock',
 'product_codes','upc','barcode','supplier_id','supplier_code',
 'product_suppliers','supply_price','cost','reorder_point','reorder_setup_needed'
]);
export function buildConsignmentProductPreview({item,selectedOriginal=null,categoryId,approvedAccountingCost=null}={}){
 if(!item||typeof item!=='object')throw new Error('Consignment item required.');
 const code=String(item.consignment_code||item.id||'').trim();
 if(!CODE.test(code))throw new Error('A unique consignment item code is required.');
 const price=Number(item.asking_price??item.price);
 if(!Number.isFinite(price)||price<0)throw new Error('Valid asking price required.');
 if(!categoryId||typeof categoryId!=='string')throw new Error('Verified General > Consignment category ID required.');
 if(selectedOriginal&&String(selectedOriginal.name||'').trim().toUpperCase().startsWith('USED')){
   throw new Error('A used product cannot be selected as the original new-product template.');
 }
 const name=String(selectedOriginal?.name||item.approved_name||item.name||item.submitted_name||'').trim();
 if(!name)throw new Error('A product name is required.');
 const payload={
  name:'USED — '+name.replace(/^USED\s*[—:\-]+\s*/i,''),
  sku:code,
  product_category_id:categoryId,
  price_excluding_tax:Math.round(price*100)/100,
  is_active:true
 };
 if(selectedOriginal?.description)payload.description=String(selectedOriginal.description).slice(0,3000);
 if(selectedOriginal?.brand_id)payload.brand_id=String(selectedOriginal.brand_id);
 // The existing Special Orders create route requires supply_price.
 // Do not guess at consignment accounting treatment. Do not enable writes
 // until this decision is verified by the store.
 if(approvedAccountingCost!=null){
   const cost=Number(approvedAccountingCost);
   if(!Number.isFinite(cost)||cost<0)throw new Error('Invalid approved consignment accounting cost.');
   payload.supply_price=Math.round(cost*100)/100;
 }
 return {
  preview:payload,
  sourceProductId:selectedOriginal?.id||selectedOriginal?.lightspeed_product_id||null,
  copyExclusions:HIDDEN_COPY_FIELDS,
  canPostViaExistingSpecialOrdersRoute:payload.supply_price!==undefined,
  warnings:payload.supply_price===undefined?['Cost/accounting treatment requires approval before using the existing product creation endpoint.']:[],
  onlineEnabled:false,
  imagesCopied:false
 };
}
