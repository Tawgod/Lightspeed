import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {createInvoicePersistenceFixture} from '../services/lightspeed/invoicePersistenceFixture.js';
import {PURCHASING_FIXTURE_OPERATIONS as O} from '../services/lightspeed/purchasingReviewWorkflow.js';
const uri=process.env.HC_TEST_DATABASE_URL;
const opts={skip:!uri?'Disposable PostgreSQL required':false};
const at='2026-11-24T15:00:00.000Z', hash='a'.repeat(64);
function evidence(id='I1'){
 const source={complete:true,readAt:at};
 return {document:{source:{provider:'graph',accountRef:'mail',messageId:'M1',senderKey:'sender@example.test',observedAt:at},attachment:{id:'A1',mime:'application/pdf',byteLength:100,sha256:hash,scanState:'clean',scanRef:'scan'},extraction:{documentHash:hash,kind:'invoice',parserVersion:'fixture',references:[],lines:[{id:'L1',page:1,documentRef:'page1',supplierSku:'001',quantity:'2',unitCost:'3.00',currency:'USD'}]}},
 priorDocuments:[],documentHistoryComplete:true,aliasRows:[{source:'purchasing:graph:mail',alias:'sender@example.test',supplierId:'S1',verified:true,provenance:'alias',observedAt:at}],aliasCoverage:true,
 header:{invoiceId:id,invoiceNumber:'0001',outletId:'O1',supplierId:'S1',reviewRef:'R1',documentHash:hash,poReference:null},
 targets:[{invoiceLineId:'L1',productId:'PR1',variantId:null,reviewRef:'T1',documentHash:hash,identityEvidenceRef:'identity'}],
 linkRows:[{productId:'PR1',variantId:null,supplierId:'S1',supplierSku:'001',primary:true,source:'catalog',provenance:'link',observedAt:at}],linkCoverage:true,
 poList:{items:[],source,scannedCount:0,unresolvedReferenceCount:0},poDetail:null,priorInvoices:[],invoiceHistoryComplete:true,quantityEvidence:{priorLines:[],coverageComplete:true},poVersion:null,historyVersion:'H1',catalogVersion:'C1'};
}
async function fixture(fn){
 const u=new URL(uri);if(!['localhost','127.0.0.1'].includes(u.hostname)||u.pathname!=='/hc_test'||u.username!=='hc_test')throw Error('Disposable local test DB required');
 const pool=new pg.Pool({connectionString:uri,max:8}), s='purchase_fixture_'+randomUUID().replaceAll('-','');
 let deny=new Set(), scopedDeny=false, failIntent=false, now=at;const inputs=new Map([['I1',evidence()],['I2',evidence('I2')]]);
 try{
 await pool.query('CREATE SCHEMA '+s);
 await pool.query('CREATE TABLE '+s+'.commands(scope text,key text,fingerprint text,result jsonb,PRIMARY KEY(scope,key)); CREATE TABLE '+s+'.invoices(id text PRIMARY KEY, record jsonb); CREATE TABLE '+s+'.identities(invoice_id text PRIMARY KEY, source_key text UNIQUE, document_hash text UNIQUE,supplier_id text,invoice_number text, UNIQUE(supplier_id,invoice_number)); CREATE TABLE '+s+'.outbox(id text PRIMARY KEY, intent jsonb); CREATE TABLE '+s+'.audit(id bigint GENERATED ALWAYS AS IDENTITY, event jsonb)');
 const transaction=async work=>{const c=await pool.connect();try{
 await c.query('BEGIN');
 const tx={
 async claim({scope,key,fingerprint}){const ins=await c.query('INSERT INTO '+s+'.commands(scope,key,fingerprint) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING key',[scope,key,fingerprint]);if(ins.rowCount)return {state:'claimed'};const r=(await c.query('SELECT fingerprint,result FROM '+s+'.commands WHERE scope=$1 AND key=$2 FOR UPDATE',[scope,key])).rows[0];return r?.fingerprint===fingerprint&&r.result!==null?{state:'replay',result:r.result}:{state:'conflict'};},
 async complete({scope,key,fingerprint,result}){assert.equal((await c.query('UPDATE '+s+'.commands SET result=$4 WHERE scope=$1 AND key=$2 AND fingerprint=$3 AND result IS NULL',[scope,key,fingerprint,JSON.stringify(result)])).rowCount,1);},
 appendAudit:e=>c.query('INSERT INTO '+s+'.audit(event) VALUES($1)',[JSON.stringify(e)]),
 async lockInvoice(id){await c.query('INSERT INTO '+s+'.invoices(id) VALUES($1) ON CONFLICT DO NOTHING',[id]);return (await c.query('SELECT record FROM '+s+'.invoices WHERE id=$1 FOR UPDATE',[id])).rows[0].record;},
 loadInvoiceEvidence:async id=>structuredClone(inputs.get(id)),
 async reserveDocumentIdentity(r){await c.query('INSERT INTO '+s+'.identities VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[r.invoiceId,r.sourceKey,r.documentHash,r.supplierId,r.invoiceNumber]);return (await c.query('SELECT 1 FROM '+s+'.identities WHERE invoice_id=$1 AND source_key=$2 AND document_hash=$3 AND supplier_id=$4 AND invoice_number=$5',[r.invoiceId,r.sourceKey,r.documentHash,r.supplierId,r.invoiceNumber])).rowCount===1;},
 saveInvoiceReview:r=>c.query('UPDATE '+s+'.invoices SET record=$2 WHERE id=$1',[r.invoiceId,JSON.stringify(r)]),
 saveInvoiceApproval:({invoiceId,approval})=>c.query("UPDATE "+s+".invoices SET record=jsonb_set(record,'{approval}',$2::jsonb) WHERE id=$1",[invoiceId,JSON.stringify(approval)]),
 enqueueReviewIntent:async r=>{await c.query('INSERT INTO '+s+'.outbox VALUES($1,$2)',[r.id,JSON.stringify(r)]);if(failIntent)throw Error('fixture rollback');}
 };const result=await work(tx);await c.query('COMMIT');return result;
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}};
 const api=createInvoicePersistenceFixture({transaction,authorize:async q=>!deny.has(q.operation)&&!(scopedDeny&&q.context.resource.supplierId),auditDenied:e=>pool.query('INSERT INTO '+s+'.audit(event) VALUES($1)',[JSON.stringify(e)]),resolveActor:async ctx=>ctx.actor,clock:()=>new Date(now)});
 const submit=(action,extra={})=>api.submit({context:{actor:'employee-1'},invoiceId:'I1',action,expectedRevision:0,expectedFingerprint:null,requestId:'req-1',...extra});
 const read=async(id='I1')=>(await pool.query('SELECT record FROM '+s+'.invoices WHERE id=$1',[id])).rows[0]?.record;
 const counts=async()=>Object.fromEntries(await Promise.all(['commands','invoices','identities','outbox','audit'].map(async t=>[t,Number((await pool.query('SELECT count(*) FROM '+s+'.'+t)).rows[0].count)])));
 const approve=async(extra={})=>{const r=await read();return submit('approve',{expectedRevision:r.revision.revision,expectedFingerprint:r.revision.fingerprint,requestId:'approval-1',...extra});};
 await fn({submit,approve,read,counts,inputs,deny,scopeDeny:()=>scopedDeny=true,failIntent:v=>failIntent=v,setTime:v=>now=v});
 }finally{await pool.query('DROP SCHEMA IF EXISTS '+s+' CASCADE');await pool.end();}
}
test('PG concurrent same request commits once; different actor cannot replay',opts,async()=>fixture(async f=>{
 const r=await Promise.all([f.submit('review'),f.submit('review')]);assert.equal(r.filter(x=>x.replayed).length,1);
 assert.deepEqual(await f.counts(),{commands:1,invoices:1,identities:1,outbox:0,audit:1});
 await assert.rejects(f.submit('review',{context:{actor:'employee-2'}}),{code:'CORE_KEY_CONFLICT'});
}));
test('PG competing invoice identity and concurrent revision conflict',opts,async()=>fixture(async f=>{
 const results=await Promise.allSettled([f.submit('review'),f.submit('review',{invoiceId:'I2',requestId:'req-2'})]);
 assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.deepEqual(await f.counts(),{commands:1,invoices:1,identities:1,outbox:0,audit:1});
}));
test('PG approval actor/revision binding and atomic outbox replay',opts,async()=>fixture(async f=>{
 await f.submit('review');f.setTime('2026-11-24T15:01:00.000Z');const r=await Promise.all([f.approve(),f.approve()]);
 assert.equal(r.filter(x=>x.replayed).length,1);assert.equal((await f.read()).approval.actor,'employee-1');
 assert.deepEqual(await f.counts(),{commands:2,invoices:1,identities:1,outbox:1,audit:2});
 f.deny.add(O.approve);await assert.rejects(f.approve(),{code:'CORE_FORBIDDEN'});
}));
test('PG rollback approval and outbox together, retry succeeds',opts,async()=>fixture(async f=>{
 await f.submit('review');f.setTime('2026-11-24T15:01:00.000Z');f.failIntent(true);await assert.rejects(f.approve());
 assert.equal((await f.read()).approval,null);assert.deepEqual(await f.counts(),{commands:1,invoices:1,identities:1,outbox:0,audit:1});
 f.failIntent(false);await f.approve();assert.equal((await f.counts()).outbox,1);
}));
test('PG changed evidence prevents approval; revision clears prior approval',opts,async()=>fixture(async f=>{
 await f.submit('review');f.setTime('2026-11-24T15:01:00.000Z');f.inputs.get('I1').catalogVersion='C2';await assert.rejects(f.approve(),{code:'INVOICE_EVIDENCE_CHANGED'});
 const r=await f.read();await f.submit('review',{expectedRevision:1,expectedFingerprint:r.revision.fingerprint,requestId:'req-2'});
 f.setTime('2026-11-24T15:02:00.000Z');await f.approve();const next=await f.read();assert.equal(next.approval.revision,2);
 f.setTime('2026-11-24T15:03:00.000Z');await f.submit('review',{expectedRevision:2,expectedFingerprint:next.revision.fingerprint,requestId:'req-3'});assert.equal((await f.read()).approval,null);
}));
test('PG scoped denial rolls back and audit persists',opts,async()=>fixture(async f=>{
 f.scopeDeny();await assert.rejects(f.submit('review'),{code:'CORE_FORBIDDEN'});
 assert.deepEqual(await f.counts(),{commands:0,invoices:0,identities:0,outbox:0,audit:1});
}));
