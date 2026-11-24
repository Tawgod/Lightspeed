// Read-only normalized evidence, not eligibility or execution authority.
// The existing vendor/feature adapters must establish event semantics.
import { LightspeedIncompleteReadError } from './readCollection.js';
const fail=()=>{throw new LightspeedIncompleteReadError('Invalid sale workflow evidence.');};
const obj=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const id=v=>typeof v==='string'&&v.length>0&&v.length<=256&&v.trim()===v&&!/[\x00-\x1f\x7f]/.test(v);
const decimal=v=>typeof v==='string'&&/^-?\d{1,18}(?:\.\d{1,6})?$/.test(v);
const qty=v=>decimal(v)&&!v.startsWith('-');
const list=v=>{if(!Array.isArray(v)||v.length>1000)fail();return v;};
const checkedId=v=>{if(!id(v))fail();return v;};
const unique=(rows,key)=>{if(new Set(rows.map(r=>r[key])).size!==rows.length)fail();return rows;};
const association=(row,key,nested)=>{
 if(row[nested]!=null&&!obj(row[nested]))fail();
 const values=[row[key],row[nested]?.id].filter(v=>v!=null);
 if(values.some(v=>!id(v))||new Set(values).size>1)fail();
 return values[0]??null;
};
const fields=(row,names,validate)=>{
 const values=names.map(k=>row[k]).filter(v=>v!=null);
 if(values.some(v=>!validate(v))||new Set(values).size>1)fail();
 return values[0]??null;
};
const readArray=(row,a,b)=>{
 if(row[a]!=null&&row[b]!=null)fail(); // competing aliases need source reconciliation
 const value=row[a]??row[b];
 return value==null?null:list(value);
};
export function projectSaleWorkflow({saleId,sale,fulfillments,depositEvents=[],workOrders=[]}={}){
 if(!id(saleId))throw new TypeError('Exact sale ID required.');
 if(!obj(sale)||sale.id!==saleId)fail();
 const customerId=association(sale,'customer_id','customer');
 const lines=readArray(sale,'line_items','register_sale_products');
 const payments=readArray(sale,'payments','register_sale_payments');
 const lineItems=lines===null?null:unique(lines.map(row=>{
  if(!obj(row))fail();
  return {lineId:checkedId(row.id),productId:checkedId(row.product_id),quantity:fields(row,['quantity','unit_quantity'],qty)};
 }),'lineId');
 const paymentEvidence=payments===null?null:unique(payments.map(row=>{
  if(!obj(row))fail();
  return {paymentId:checkedId(row.id),amount:fields(row,['amount','amount_including_tax','payment_amount'],decimal)};
 }),'paymentId');
 const lineMap=new Map((lineItems??[]).map(r=>[r.lineId,r]));
 const physical=unique(list(fulfillments).map(row=>{
  if(!obj(row)||association(row,'sale_id','sale')!==saleId)fail();
  const events=row.line_items==null?null:unique(list(row.line_items).map(l=>{
   if(!obj(l))fail();
   const lineId=checkedId(l.sale_line_item_id), productId=checkedId(l.product_id);
   const saleLine=lineMap.get(lineId);
   if(saleLine&&saleLine.productId!==productId)fail();
   return {lineId,productId,association:saleLine?'source-confirmed':lineItems===null?'unknown':'orphaned',
    picked:fields(l,['picked_quantity'],qty),packed:fields(l,['packed_quantity'],qty),
    fulfilled:fields(l,['fulfilled_quantity'],qty),customerPickup:null};
  }),'lineId');
  return {fulfillmentId:checkedId(row.id),lines:events};
 }),'fulfillmentId');
 const deposits=unique(list(depositEvents).map(row=>{
  if(!obj(row)||row.saleId!==saleId||!['deposit-recorded','deposit-reversed'].includes(row.kind)||!qty(row.amount)||! /^[A-Z]{3}$/.test(row.currency??''))fail();
  return {eventId:checkedId(row.eventId),kind:row.kind,amount:row.amount,currency:row.currency};
 }),'eventId');
 const orders=unique(list(workOrders).map(row=>{
  if(!obj(row)||row.saleId!==saleId||!id(row.state))fail();
  return {workOrderId:checkedId(row.workOrderId),state:row.state};
 }),'workOrderId');
 return {saleId,customerId,state:fields(sale,['state','status'],id),lineItems,paymentEvidence,
  depositEvidence:deposits,workOrderEvidence:orders,fulfillmentEvidence:physical,
  coverage:{sale:'single-record',payments:payments===null?'unknown':'supplied-records',deposits:'supplied-evidence-only',workOrders:'supplied-evidence-only',fulfillment:'single-page',complete:false},
  depositBalance:null,customerPickupQuantity:null,executionAuthorized:false};
}
// Existing injected vendor readers plus optional trusted feature evidence readers.
// No new transport, route, mutation, authorization mechanism or source inference.
export function createSaleWorkflowRead({sales,fulfillments,readDepositEvents=async()=>[],readWorkOrders=async()=>[]}={}){
 if(typeof sales?.get!=='function'||typeof fulfillments?.forSale!=='function'||typeof readDepositEvents!=='function'||typeof readWorkOrders!=='function')throw new TypeError('Injected read services required.');
 return Object.freeze({async get(saleId,{correlationId}={}){
  if(!id(saleId))throw new TypeError('Exact sale ID required.');
  const options=correlationId===undefined?[]:[{correlationId}];
  const body=await sales.get(saleId,...options);
  const sale=obj(body)&&Object.hasOwn(body,'data')?body.data:body;
  if(!obj(sale)||sale.id!==saleId)fail();
  const [physical,depositEvents,workOrders]=await Promise.all([fulfillments.forSale(saleId,...options),readDepositEvents(saleId,...options),readWorkOrders(saleId,...options)]);
  const raw=list(physical).map(row=>{
   if(!obj(row)||!obj(row.raw)||row.id!==row.raw.id||row.saleId!==saleId)fail();
   return row.raw;
  });
  return projectSaleWorkflow({saleId,sale,fulfillments:raw,depositEvents,workOrders});
 }});
}
