// Test-only scoped source contract. Not a raw vendor adapter or Security registry.
import {randomUUID} from 'node:crypto';
import {LightspeedIncompleteReadError} from './readCollection.js';
const id=v=>typeof v==='string'&&v.length>0&&v.length<=256&&v.trim()===v&&!/[\x00-\x1f\x7f]/.test(v);
const fail=()=>{throw new LightspeedIncompleteReadError('Invalid scoped evidence.');};
const deny=()=>{const e=new Error('Read not authorized.');e.code='CORE_FORBIDDEN';throw e;};
const fields=Object.freeze({id:'customers.search',first_name:'customers.search',last_name:'customers.search',email:'customers.contacts.read',phone:'customers.contacts.read',notes:'customers.notes.read'});
export function createScopedCustomerFixture({environment,authorize,readProjected}={}){
 if(environment!=='test'||typeof authorize!=='function'||typeof readProjected!=='function')throw new TypeError('Test-only projected source required.');
 return Object.freeze({async search(actor,query,{outlet,purpose,requestedFields=['id','first_name','last_name'],firstPage=true}={}){
  if(!id(actor?.actorId)||!id(actor?.tenantId)||!id(outlet)||!id(purpose))deny();
  if(typeof query!=='string'||query.length>256||typeof firstPage!=='boolean'||!Array.isArray(requestedFields)||!requestedFields.includes('id')||new Set(requestedFields).size!==requestedFields.length||requestedFields.some(f=>!Object.hasOwn(fields,f)))throw new TypeError('Invalid search scope.');
  const subject=Object.freeze({actorId:actor.actorId,tenantId:actor.tenantId});
  const selected=Object.freeze([...requestedFields]),correlationId=randomUUID();
  const resource=Object.freeze({kind:'customer-search',outlet,purpose});
  async function allowed(operation,resource,field,phase){
   try{return await authorize({actor:subject,environment:'test',operation,resource,field,phase,correlationId})===true;}catch{return false;}
  }
  async function requireField(field,resource,phase){if(!await allowed(fields[field],resource,field,phase))deny();}
  if(!query.trim())return {correlationId,rows:[],coverage:'not-queried',complete:false};
  // Search by contact itself requires contact admission, even if output omits it.
  const matchField=query.includes('@')?'email':/^[+()\d\s.-]{7,}$/.test(query.trim())?'phone':null;
  if(matchField)await requireField(matchField,resource,'io');
  for(const field of selected)await requireField(field,resource,'io');
  // Trusted fixture source must enforce tenant/outlet and field selection BEFORE
  // retrieving records. Reject extra fields rather than silently hiding them.
  const rows=await readProjected(Object.freeze({actor:subject,query:query.trim(),outlet,purpose,fields:selected,firstPage,correlationId}));
  if(!Array.isArray(rows)||rows.length>(firstPage?20:20000))fail();
  const seen=new Set(),out=[];
  for(const row of rows){
   if(!row||typeof row!=='object'||Array.isArray(row)||!id(row.id)||seen.has(row.id)||Object.keys(row).some(k=>!selected.includes(k)))fail();
   seen.add(row.id);
   const target=Object.freeze({kind:'customer',id:row.id,outlet,purpose});
   if(matchField)await requireField(matchField,target,'projection');
   const item={};
   for(const field of selected){
    await requireField(field,target,'projection');
    if(Object.hasOwn(row,field)){if(row[field]!==null&&typeof row[field]!=='string')fail();item[field]=row[field];}
   }
   out.push(item);
  }
  if(matchField)await requireField(matchField,resource,'projection');
  for(const field of selected)await requireField(field,resource,'projection');
  return {correlationId,rows:out,coverage:firstPage?'single-page':'search-candidates-only',complete:false};
 }});
}
// Exact decimal arithmetic on supplied normalized evidence only, not a posting
// eligibility decision. No inference from incomplete history or vendor status.
const units=v=>{if(typeof v!=='string'||!/^\d{1,18}(?:\.\d{1,6})?$/.test(v))fail();const [a,b='']=v.split('.');return BigInt(a)*1000000n+BigInt(b.padEnd(6,'0'));};
const fmt=v=>{const s=v.toString().padStart(7,'0');return s.slice(0,-6)+'.'+s.slice(-6);};
const currency=v=>typeof v==='string'&&/^[A-Z]{3}$/.test(v);
export function assessCumulativeEvidence({saleId,customerId,revision,lines,payments,deposits,credits,events,coverage}={}){
 if(!id(saleId)||!id(customerId)||!id(revision))fail();
 const maps=new Map(),eventIds=new Set();
 const kinds={pickup:'line',return:'line','payment-reversal':'payment','deposit-reversal':'deposit','credit-reversal':'credit'};
 for(const [type,rows] of [['line',lines],['payment',payments],['deposit',deposits],['credit',credits]]){
  if(!Array.isArray(rows)||rows.length>1000)fail();
  const map=new Map();maps.set(type,map);
  for(const row of rows){
   if(!id(row?.id)||map.has(row.id)||row.saleId!==saleId||row.customerId!==customerId)fail();
   if(type==='line'?!id(row.productId):!currency(row.currency))fail();
   const limit=units(type==='line'?row.quantity:row.amount);
   map.set(row.id,{row,limit,pickup:0n,returned:0n,reversed:0n});
  }
 }
 if(!Array.isArray(events)||events.length>4000)fail();
 const originals=new Map();
 // Ordered source chronology is explicit, not inferred from input timestamps.
 let last=0;
 for(const e of events){
  if(!id(e?.eventId)||eventIds.has(e.eventId)||e.saleId!==saleId||e.customerId!==customerId||!Number.isSafeInteger(e.sequence)||e.sequence<=last)fail();
  last=e.sequence;eventIds.add(e.eventId);
  const type=e.kind==='pickup-reversal'?'line':kinds[e.kind];
  if(!type)fail();
  const target=maps.get(type).get(e.targetId);
  if(!target||(type==='line'?e.productId!==target.row.productId:e.currency!==target.row.currency))fail();
  const n=units(type==='line'?e.quantity:e.amount);if(n===0n)fail();
  if(e.kind==='pickup'){
   if(e.originalEventId!=null)fail();target.pickup+=n;originals.set(e.eventId,{target,left:n});
  }else if(e.kind==='pickup-reversal'){
   const original=originals.get(e.originalEventId);
   if(!original||original.target!==target||original.left<n)fail();original.left-=n;target.pickup-=n;
  }else if(e.kind==='return'){
   if(e.originalEventId!=null)fail();target.returned+=n;
  }else{
   if(e.originalEventId!=null)fail();target.reversed+=n;
  }
  if(target.pickup>target.limit||target.returned>target.limit||target.reversed>target.limit)fail();
 }
 const complete=coverage?.revision===revision&&coverage?.complete===true;
 const result=[];
 for(const [type,map] of maps)for(const [targetId,t] of map){
  result.push(type==='line'?{type,targetId,productId:t.row.productId,observedPickup:fmt(t.pickup),observedReturn:fmt(t.returned),remainingPickup:complete?fmt(t.limit-t.pickup):null,remainingReturn:complete?fmt(t.limit-t.returned):null}:{type,targetId,currency:t.row.currency,observedReversal:fmt(t.reversed),remainingReversal:complete?fmt(t.limit-t.reversed):null});
 }
 return {saleId,customerId,revision,coverage:complete?'supplied-complete-fixture':'incomplete',items:result,eligibility:'requires-review',executionAuthorized:false,stockEffect:null,refundAuthorized:false,creditAuthorized:false};
}
