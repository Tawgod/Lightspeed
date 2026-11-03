// Read-only sale reconciliation and credit-eligibility planning.
// Explicitly does NOT post store credit or change product activation.
export const HOLD_MS=72*60*60*1000;
export function creditEligibility({sale,returns=[],now=new Date(),rate=0.8}={}){
 if(!sale||!sale.sale_id||!sale.item_id||!sale.sold_at)throw new Error('Verified sale identity and timestamp required');
 const when=new Date(sale.sold_at).getTime(),clock=new Date(now).getTime();
 if(!Number.isFinite(when)||!Number.isFinite(clock)||clock<when)throw new Error('Invalid sale dates');
 if(!Number.isInteger(sale.price_cents)||sale.price_cents<0)throw new Error('Sale price cents required');
 if(!Number.isFinite(rate)||rate<0||rate>1)throw new Error('Invalid credit rate');
 const relevantReturns=returns.filter(x=>x.sale_id===sale.sale_id&&x.item_id===sale.item_id);
 if(relevantReturns.some(x=>x.status==='RETURNED'||x.status==='VOIDED'))return {eligible:false,reason:'SALE_REVERSED',eligibleAt:new Date(when+HOLD_MS).toISOString()};
 if(relevantReturns.some(x=>x.status==='UNKNOWN'||x.status==='PENDING'))return {eligible:false,reason:'RETURN_RECONCILIATION_PENDING',eligibleAt:new Date(when+HOLD_MS).toISOString()};
 const due=when+HOLD_MS;
 if(clock<due)return {eligible:false,reason:'HOLD_PERIOD',eligibleAt:new Date(due).toISOString()};
 if(sale.reconciliation_complete!==true)return {eligible:false,reason:'SALE_RECONCILIATION_UNVERIFIED',eligibleAt:new Date(due).toISOString()};
 return {eligible:true,reason:'READY_FOR_MANUAL_REVIEW',eligibleAt:new Date(due).toISOString(),
 creditCents:Math.round(sale.price_cents*rate),
 idempotencyKey:'consignment-credit:'+sale.item_id+':'+sale.sale_id};
}
