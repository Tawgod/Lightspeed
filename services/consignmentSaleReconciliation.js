// Read-only sale/return event reconciliation. No POS mutations or credit posting.
const accepted=new Set(['SALE','RETURN','VOID']);
export function reconcileConsignmentEvents({item,events=[]}={}){
 if(!item?.consignment_code||!Array.isArray(events))throw new Error('Item and event list required');
 const code=String(item.consignment_code);
 const relevant=events.filter(x=>x.consignment_code===code);
 const seen=new Set(),unique=[];
 for(const event of relevant){
  if(!event?.event_id||!accepted.has(event.type)||!event.sale_id)throw new Error('Unverified sale/return event');
  if(seen.has(event.event_id))continue;
  seen.add(event.event_id);unique.push(event);
 }
 const sales=unique.filter(x=>x.type==='SALE');
 if(sales.length!==1)return {verified:false,reason:sales.length?'MULTIPLE_SALES':'SALE_NOT_FOUND',itemCode:code};
 const sale=sales[0];
 if(!sale.sold_at||!Number.isInteger(sale.price_cents)||sale.price_cents<0)
  return {verified:false,reason:'INCOMPLETE_SALE',itemCode:code};
 const changes=unique.filter(x=>x.sale_id===sale.sale_id&&x.type!=='SALE');
 if(changes.some(x=>x.type==='RETURN'||x.type==='VOID'))
  return {verified:false,reason:'SALE_REVERSED',itemCode:code,saleId:sale.sale_id};
 if(unique.some(x=>x.sale_id!==sale.sale_id))
  return {verified:false,reason:'UNMATCHED_EVENT',itemCode:code};
 return {verified:true,itemCode:code,sale:{sale_id:sale.sale_id,item_id:code,
 sold_at:sale.sold_at,price_cents:sale.price_cents,reconciliation_complete:true},
 returns:[],eventCount:unique.length};
}
