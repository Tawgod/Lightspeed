// HC-INITIAL-COUNT/0.1: pure server-side domain functions, not an endpoint or auth engine.
import {fingerprintLightspeedPayload as hash} from './idempotency.js';
export const VERSION='HC-INITIAL-COUNT/0.1';
const require=(ok,code='INVALID_INPUT')=>{if(!ok)throw Object.assign(new Error(code),{code})};
const str=x=>typeof x==='string'&&x.length>0&&x.length<=512&&x.trim()===x&&!/[\u0000-\u001f\u007f]/.test(x);
const instant=x=>typeof x==='string'&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x;
const copy=x=>structuredClone(x);
const key=x=>JSON.stringify([x.productId,x.variantId]);
const identity=x=>x&&str(x.productId)&&(x.variantId===null||str(x.variantId));
const exact=(x,ks)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===ks.length&&ks.every(k=>Object.hasOwn(x,k));
const n=(x,signed=false)=>{require(typeof x==='string'&&(signed?/^-?\d{1,12}(?:\.\d{1,6})?$/:/^\d{1,12}(?:\.\d{1,6})?$/).test(x),'INVALID_QUANTITY');const [a,b='']=x.replace(/^-/,'').split('.');return (BigInt(a)*1000000n+BigInt(b.padEnd(6,'0')))*(x.startsWith('-')?-1n:1n)};
const fmt=(v,p=6)=>{const d=(v<0n?-v:v).toString().padStart(p+1,'0'),f=d.slice(-p).replace(/0+$/,'');return (v<0n?'-':'')+d.slice(0,-p)+(f?'.'+f:'')};
const abs=x=>x<0n?-x:x;
const amount=x=>{const [a,b='']=x.replace(/^-/,'').split('.');return (BigInt(a)*1000000000000n+BigInt(b.padEnd(12,'0')))*(x.startsWith('-')?-1n:1n)};
const qty=x=>{const v=n(x??'1');require(v>0n,'INVALID_QUANTITY');return fmt(v)};
export function createSession({tenant,sessionId,outletId,actorId,at}){
 require([tenant,sessionId,outletId,actorId].every(str)&&instant(at));
 return {version:VERSION,tenant,sessionId,outletId,revision:0,state:'open',openedBy:actorId,openedAt:at,entries:[],imports:[],receipts:[],audit:[],finalization:null};
}
// Catalog owns resolution. Trusted caller supplies the exact result and independently admitted scope.
// null permits fast capture before lookup; it never constitutes a verified no-match.
function resolve(result,s,scope,selection=null){
 if(result===null)return {status:'PENDING'};
 require(result&&scope&&['tenant','environment','location','sourceRef','revision'].every(k=>str(scope[k])&&result.scope?.[k]===scope[k])&&scope.tenant===s.tenant&&scope.location===s.outletId,'CATALOG_SCOPE');
 require(['EXACT_UNIQUE','AMBIGUOUS','NO_MATCH','INCOMPLETE','UNAVAILABLE'].includes(result.status)&&Array.isArray(result.candidates),'CATALOG_RESULT');
 const evidence={sourceRef:scope.sourceRef,revision:scope.revision,environment:scope.environment};
 if(result.status==='EXACT_UNIQUE'){
  require(result.complete===true&&result.candidates.length===1&&identity(result.candidates[0])&&str(result.candidates[0].name),'CATALOG_RESULT');
  const c=result.candidates[0];if(selection)require(key(c)===key(selection),'SELECTION_MISMATCH');
  if(c.active!==true)return {status:'INACTIVE',...evidence};
  return {status:'EXACT_UNIQUE',productId:c.productId,variantId:c.variantId,name:c.name,...evidence};
 }
 if(result.status==='NO_MATCH')require(result.complete===true&&result.candidates.length===0,'CATALOG_RESULT');
 return {status:result.status,...evidence};
}
function entry(row,s,t,source,result){
 require(exact(row,['entryId','identifier','selection','quantity','observedAt'])&&str(row.entryId)&&instant(row.observedAt)&&row.observedAt<=t.at&&row.observedAt>=s.openedAt);
 require((str(row.identifier)&&row.selection===null)||(row.identifier===null&&identity(row.selection)&&exact(row.selection,['productId','variantId'])));
 const quantity=qty(row.quantity),resolution=resolve(result,s,t.catalogScope,row.selection);
 return {entryId:row.entryId,revision:1,original:{...copy(row),quantity,resolution:copy(resolution),actorId:t.actorId,recordedAt:t.at,source},current:{quantity,resolution,removed:false},corrections:[]};
}
// Must execute under Core-owned atomic session transaction; state is trusted persisted JSON.
// Security must authorize operation before calling, including replay/readback, with current actor.
export function transition(s,c,t){
 require(s?.version===VERSION&&t?.tenant===s.tenant&&t.sessionId===s.sessionId&&t.outletId===s.outletId&&str(t.actorId)&&instant(t.at)&&t.at>=s.openedAt,'SCOPE');
 require(exact(c,['requestId','type','data'])&&str(c.requestId)&&['add','import','correct','finalize'].includes(c.type));
 const digest=hash({actorId:t.actorId,command:c}),old=s.receipts.find(r=>r.requestId===c.requestId);
 if(old){require(old.digest===digest,'REPLAY_CONFLICT');return {state:copy(s),receipt:copy(old.receipt),replayed:true}}
 require(s.state==='open','FINALIZED');
 const next=copy(s),d=c.data;let affected=[];
 const insert=e=>{require(!next.entries.some(x=>x.entryId===e.entryId),'DUPLICATE_ENTRY');next.entries.push(e);affected.push(e.entryId)};
 if(c.type==='add'){
  require(exact(d,['sourceId','row'])&&str(d.sourceId)&&d.sourceId===t.sourceId&&['scan','manual'].includes(t.sourceKind),'SOURCE');
  insert(entry(d.row,s,t,{kind:t.sourceKind,sourceId:t.sourceId},t.resolution??null));
 }else if(c.type==='import'){
  require(exact(d,['sourceId','batchId','fileDigest','rows'])&&str(d.sourceId)&&d.sourceId===t.sourceId&&t.sourceKind==='csv'&&str(d.batchId)&&/^[a-f0-9]{64}$/.test(d.fileDigest)&&d.fileDigest===t.fileDigest&&Array.isArray(d.rows)&&d.rows.length>0&&d.rows.length<=500,'IMPORT');
  require(Array.isArray(t.resolutions)&&t.resolutions.length===d.rows.length,'IMPORT');
  const semantic=hash(d.rows.map(r=>[r.identifier,r.selection,qty(r.quantity)]));
  require(!s.imports.some(x=>x.batchId===d.batchId||x.fileDigest===d.fileDigest||x.semantic===semantic),'DUPLICATE_IMPORT');
  d.rows.forEach((r,i)=>insert(entry(r,s,t,{kind:'csv',sourceId:t.sourceId,batchId:d.batchId,fileDigest:d.fileDigest,row:i+1},t.resolutions[i])));
  next.imports.push({batchId:d.batchId,fileDigest:d.fileDigest,semantic,entryIds:copy(affected),actorId:t.actorId,sourceId:t.sourceId,recordedAt:t.at});
 }else if(c.type==='correct'){
  require(exact(d,['entryId','expectedRevision','action','quantity','reason'])&&str(d.entryId)&&str(d.reason)&&Number.isSafeInteger(d.expectedRevision)&&['quantity','remove','resolve'].includes(d.action));
  const e=next.entries.find(x=>x.entryId===d.entryId);require(e&&e.revision===d.expectedRevision&&!e.current.removed,'STALE_ENTRY');
  const before=copy(e.current);
  if(d.action==='quantity')e.current.quantity=qty(d.quantity);
  else if(d.action==='remove'){require(d.quantity===null);e.current.removed=true}
  else {require(d.quantity===null&&e.current.resolution.status!=='EXACT_UNIQUE','RESOLUTION_NOT_PENDING');const r=resolve(t.resolution,s,t.catalogScope);require(r.status==='EXACT_UNIQUE','UNRESOLVED');e.current.resolution=r}
  require(hash(before)!==hash(e.current),'NO_CHANGE');e.revision++;
  e.corrections.push({requestId:c.requestId,revision:e.revision,action:d.action,reason:d.reason,actorId:t.actorId,recordedAt:t.at,before,after:copy(e.current)});affected=[e.entryId];
 }else{
  require(exact(d,['confirmed','expectedRevision'])&&d.confirmed===true,'CONFIRMATION');
  require(d.expectedRevision===s.revision,'STALE_SESSION');
  require(next.entries.some(e=>!e.current.removed)&&next.entries.every(e=>e.current.removed||e.current.resolution.status==='EXACT_UNIQUE'),'UNRESOLVED_OR_EMPTY');
  next.state='finalized';next.finalization={actorId:t.actorId,recordedAt:t.at,revision:s.revision+1,requestId:c.requestId};
 }
 next.revision++;
 const receipt={sessionId:s.sessionId,revision:next.revision,requestId:c.requestId,state:next.state,affected};
 next.receipts.push({requestId:c.requestId,digest,receipt:copy(receipt)});
 next.audit.push({requestId:c.requestId,operation:c.type,actorId:t.actorId,recordedAt:t.at,revision:next.revision,affected});
 return {state:next,receipt,replayed:false};
}
export function consolidate(s){
 const groups=new Map(),unresolved=[];
 for(const e of s.entries){if(e.current.removed)continue;const r=e.current.resolution;if(r.status!=='EXACT_UNIQUE'){unresolved.push({entryId:e.entryId,identifier:e.original.identifier,quantity:e.current.quantity,status:r.status,source:copy(e.original.source)});continue}
 const k=key(r),g=groups.get(k)||{productId:r.productId,variantId:r.variantId,name:r.name,total:0n,entryIds:[]};g.total+=n(e.current.quantity);g.entryIds.push(e.entryId);groups.set(k,g)}
 return {sessionId:s.sessionId,revision:s.revision,items:[...groups.values()].map(({total,...g})=>({...g,counted:fmt(total)})),unresolved};
}
export function history(s,{query='',limit=50,offset=0}={}){
 require(typeof query==='string'&&query.length<=512&&Number.isSafeInteger(limit)&&limit>0&&limit<=500&&Number.isSafeInteger(offset)&&offset>=0);
 const q=query.toLowerCase();return {revision:s.revision,entries:s.entries.slice().reverse().filter(e=>[e.entryId,e.original.identifier,e.original.actorId,e.current.resolution.name,e.current.resolution.productId,e.current.resolution.variantId,e.original.source.sourceId].some(x=>typeof x==='string'&&x.toLowerCase().includes(q))).slice(offset,offset+limit).map(copy)};
}
// Baseline and valuation are trusted authorized projections, never browser-supplied facts.
export function report(s,b,{valuation='none',retail=false,uncounted='pending'}={}){
 require(['none','wholesale'].includes(valuation)&&typeof retail==='boolean'&&['pending','zero','exclude'].includes(uncounted));
 require(b&&b.tenant===s.tenant&&b.outletId===s.outletId&&str(b.snapshotId)&&str(b.source)&&instant(b.asOf)&&typeof b.complete==='boolean'&&Array.isArray(b.items),'BASELINE');
 const {items,unresolved}=consolidate(s),counts=new Map(items.map(x=>[key(x),x])),expected=new Map();
 for(const r of b.items){require(identity(r)&&r.verified===true&&str(r.name)&&!expected.has(key(r)),'BASELINE_IDENTITY');if(r.expected!==null)n(r.expected,true);expected.set(key(r),r)}
 const money=v=>{if(!v||v.verified!==true||v.amount===null||!/^[A-Z]{3}$/.test(v.currency)||!str(v.basis)||!instant(v.asOf))return null;return {amount:fmt(n(v.amount)),currency:v.currency,basis:v.basis,asOf:v.asOf}};
 const rows=[];
 for(const k of new Set([...expected.keys(),...counts.keys()])){
  const a=expected.get(k),c=counts.get(k),p=c||a,counted=c?.counted??(uncounted==='zero'?'0':null),exp=a?.expected??null;
  const diff=counted===null||exp===null?null:n(counted)-n(exp,true),cost=valuation==='wholesale'?money(a?.wholesale):null,price=retail?money(a?.retail):null;
  const value=diff===null||cost===null?null:fmt(diff*n(cost.amount),12);
  rows.push({productId:p.productId,variantId:p.variantId,name:p.name,sku:a?.sku??null,expected:exp,counted,difference:diff===null?null:fmt(diff),direction:diff===null?'unknown':diff>0n?'over':diff<0n?'under':'equal',wholesale:cost,retail:price,value,retailValue:diff===null||price===null?null:fmt(diff*n(price.amount),12),uncounted:!c,excluded:!c&&uncounted==='exclude',unvalued:value===null});
 }
 return {sessionId:s.sessionId,sessionRevision:s.revision,outletId:s.outletId,state:s.state,baseline:{snapshotId:b.snapshotId,source:b.source,asOf:b.asOf,complete:b.complete},valuation,uncounted,rows,unresolved};
}
export function view(snapshot,{direction='all',unvalued=false,query='',sort='quantity',descending=true}={}){
 require(['all','over','under','equal','unknown'].includes(direction)&&['quantity','value','direction','name'].includes(sort)&&typeof unvalued==='boolean'&&typeof descending==='boolean'&&typeof query==='string');
 const q=query.toLowerCase(),matches=x=>[x.name,x.sku,x.productId,x.variantId,x.identifier,x.entryId].some(v=>typeof v==='string'&&v.toLowerCase().includes(q));
 const rows=snapshot.rows.filter(r=>(direction==='all'||r.direction===direction)&&(!unvalued||r.unvalued)&&(!q||matches(r)));
 const val=r=>sort==='quantity'?(r.difference===null?null:abs(amount(r.difference))):sort==='value'?(r.value===null?null:abs(amount(r.value))):sort==='direction'?r.direction:r.name;
 const cmp=(a,b)=>a<b?-1:a>b?1:0;
 rows.sort((a,b)=>{const x=val(a),y=val(b);return x===null||y===null?(x===y?cmp(key(a),key(b)):x===null?1:-1):(descending?-1:1)*cmp(x,y)||cmp(key(a),key(b))});
 const totals=rs=>{const m=new Map();let unknown=0;for(const r of rs){if(r.excluded)continue;if(r.value===null){unknown++;continue}const cur=r.wholesale.currency,g=m.get(cur)||{over:0n,under:0n},v=amount(r.value);if(v>0n)g.over+=v;else g.under-=v;m.set(cur,g)}return {currencies:[...m].map(([currency,g])=>({currency,overage:fmt(g.over,12),shortage:fmt(g.under,12),net:fmt(g.over-g.under,12)})),unknownValueRows:unknown}};
 const unresolved=(direction==='all'||direction==='unknown')?snapshot.unresolved.filter(e=>!q||matches(e)):[];
 return {...copy(snapshot),rows:copy(rows),unresolved:copy(unresolved),filter:{direction,unvalued,query,sort,descending},overallTotals:totals(snapshot.rows),filteredTotals:totals(rows)};
}
// CSV is a projection of the exact report view. Use text-column import for identifiers.
export function csv(v){
 const cell=x=>{if(x==null)return '""';let s=String(x);if(/^[\s]*[=+@-]/.test(s)||/^[\t\r\n]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"'};
 const numeric=x=>x==null?'':String(x);
 const columns=['kind','session','revision','baseline','source','asOf','product','variant','sku','name','expected','counted','difference','direction','wholesale','currency','basis','costAsOf','value','retail','retailCurrency','retailValue','status','identifier','entry','quantity'];
 const meta=[cell(v.sessionId),v.sessionRevision,cell(v.baseline.snapshotId),cell(v.baseline.source),cell(v.baseline.asOf)];
 const lines=[columns.join(',')];
 for(const r of v.rows)lines.push(['product',...meta,cell(r.productId),cell(r.variantId),cell(r.sku),cell(r.name),numeric(r.expected),numeric(r.counted),numeric(r.difference),cell(r.direction),numeric(r.wholesale?.amount),cell(r.wholesale?.currency),cell(r.wholesale?.basis),cell(r.wholesale?.asOf),numeric(r.value),numeric(r.retail?.amount),cell(r.retail?.currency),numeric(r.retailValue),cell(r.excluded?'excluded':r.unvalued?'unvalued':'valued'),'','',''].join(','));
 for(const e of v.unresolved)lines.push(['unresolved',...meta,...Array(16).fill(''),cell(e.status),cell(e.identifier),cell(e.entryId),numeric(e.quantity)].join(','));
 for(const [label,t] of [['overall',v.overallTotals],['filtered',v.filteredTotals]])for(const g of t.currencies)for(const k of ['overage','shortage','net'])lines.push(['total',...meta,'','','',cell(label+' '+k),'','','','', '',cell(g.currency),'','',numeric(g[k]),'','','',cell('unknown value rows: '+t.unknownValueRows),'','',''].join(','));
 return lines.join('\r\n')+'\r\n';
}
