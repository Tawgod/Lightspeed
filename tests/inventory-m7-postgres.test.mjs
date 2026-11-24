import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createLocalTransactionCandidate } from '../services/lightspeed/localTransactionCandidate.js';
import { planCountObservation, planRestockConfirmation, planReasonRevision } from '../services/lightspeed/inventoryPersistence.js';

// Disposable test adapter only. Core owns the eventual shared adapter.
const uri=process.env.HC_TEST_DATABASE_URL;
const options={skip:!uri?'Disposable PostgreSQL required':false};
const now='2026-11-24T10:30:00.000Z', before='2026-11-24T10:29:00.000Z';
const actorId='fixture-E1', key={outletId:'01',productId:'0001',variantId:null};
const reason={code:'missing',label:'Missing',revision:1,active:true,requiresNote:false,reviewFlag:'possible_shortage',appliesTo:['zero','partial']};
const locations=[{locationId:'S',outletId:'01',shelfCode:'S',area:'Storage',kind:'storage',active:true,labelDescription:'S'},{locationId:'F',outletId:'01',shelfCode:'F',area:'Floor',kind:'floor',active:true,labelDescription:'F'}];
const line={...key,lineId:'L1',fromLocationId:'S',toLocationId:'F',plannedQuantity:4};
const task={taskId:'T1',version:'v1',state:'open',lines:[line]};
const session={sessionId:'C1',state:'open',openedAt:'2026-11-24T10:00:00.000Z',outletId:'01'};
const restock={taskVersion:'v1',batchId:'B1',lines:[{...line,movedQuantity:0,reasonCode:'missing',confirmedAt:before}]};
const count={...key,scanId:'scan1',countMode:'full-outlet',countedQuantity:'3',scannedAt:before};
async function fixture(fn){
  const u=new URL(uri);
  if(!['127.0.0.1','localhost'].includes(u.hostname)||u.pathname!=='/hc_test'||u.username!=='hc_test')throw Error('Disposable local test DB required');
  const pool=new pg.Pool({connectionString:uri,max:8});
  const s='inventory_fixture_'+randomUUID().replaceAll('-','');
  try{
    await pool.query('CREATE SCHEMA '+s);
    await pool.query('CREATE TABLE '+s+'.commands(scope text,key text,fingerprint text,result jsonb,PRIMARY KEY(scope,key)); CREATE TABLE '+s+'.state(id text PRIMARY KEY,body jsonb NOT NULL); CREATE TABLE '+s+'.records(id text PRIMARY KEY,body jsonb NOT NULL); CREATE TABLE '+s+'.reviews(id text PRIMARY KEY,body jsonb NOT NULL); CREATE TABLE '+s+'.outbox(id text PRIMARY KEY,body jsonb NOT NULL); CREATE TABLE '+s+'.audit(id bigint GENERATED ALWAYS AS IDENTITY,body jsonb NOT NULL)');
    for(const [id,body] of [['task',task],['session',session],['reason',reason]])await pool.query('INSERT INTO '+s+'.state VALUES($1,$2::jsonb)',[id,JSON.stringify(body)]);
    const transaction=async work=>{
      const c=await pool.connect();
      try{
        await c.query('BEGIN');
        const tx={
          async claim({scope,key,fingerprint}){
            const insert=await c.query('INSERT INTO '+s+'.commands(scope,key,fingerprint) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING key',[scope,key,fingerprint]);
            if(insert.rowCount===1)return {state:'claimed'};
            const r=(await c.query('SELECT fingerprint,result FROM '+s+'.commands WHERE scope=$1 AND key=$2 FOR UPDATE',[scope,key])).rows[0];
            return r?.fingerprint===fingerprint&&r.result!==null?{state:'replay',result:r.result}:{state:'conflict'};
          },
          async complete({scope,key,fingerprint,result}){assert.equal((await c.query('UPDATE '+s+'.commands SET result=$4::jsonb WHERE scope=$1 AND key=$2 AND fingerprint=$3 AND result IS NULL',[scope,key,fingerprint,JSON.stringify(result)])).rowCount,1);},
          appendAudit:e=>c.query('INSERT INTO '+s+'.audit(body) VALUES($1::jsonb)',[JSON.stringify(e)]),
          lock:async id=>(await c.query('SELECT body FROM '+s+'.state WHERE id=$1 FOR UPDATE',[id])).rows[0]?.body,
          update:async(id,body)=>assert.equal((await c.query('UPDATE '+s+'.state SET body=$2::jsonb WHERE id=$1',[id,JSON.stringify(body)])).rowCount,1),
          record:(id,body)=>c.query('INSERT INTO '+s+'.records VALUES($1,$2::jsonb)',[id,JSON.stringify(body)]),
          review:(id,body)=>c.query('INSERT INTO '+s+'.reviews VALUES($1,$2::jsonb)',[id,JSON.stringify(body)]),
          enqueue:(id,body)=>c.query('INSERT INTO '+s+'.outbox VALUES($1,$2::jsonb)',[id,JSON.stringify(body)])
        };
        const result=await work(tx);await c.query('COMMIT');return result;
      }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
    };
    const auditDenied=e=>pool.query('INSERT INTO '+s+'.audit(body) VALUES($1::jsonb)',[JSON.stringify(e)]);
    const counts=async()=>Object.fromEntries(await Promise.all(['commands','records','reviews','outbox','audit'].map(async t=>[t,Number((await pool.query('SELECT count(*) FROM '+s+'.'+t)).rows[0].count)])));
    const read=async(id)=>(await pool.query('SELECT body FROM '+s+'.state WHERE id=$1',[id])).rows[0].body;
    await fn({transaction,auditDenied,counts,read});
  }finally{await pool.query('DROP SCHEMA IF EXISTS '+s+' CASCADE');await pool.end();}
}
function command(kind,payload,{commandKey='fixture-001',fail=false}={}){
  const operation={restock:'restock.confirm',count:'count.observe',reason:'reason.revise'}[kind];
  return {scope:'test:inventory:'+operation,key:commandKey,operations:[operation],context:{actorId,fixture:true},payload,
    apply:async(tx,p)=>{
      let plan;
      if(kind==='restock'){
        const t=await tx.lock('task'), r=await tx.lock('reason');
        plan=planRestockConfirmation({task:t,request:p,locations,reasons:[r],actorId,recordedAt:now});
        if(plan.status!=='planned')throw Error('invalid task');
        await tx.record('task:'+t.taskId,plan.records.confirmation);
        for(const r of plan.records.reviews)await tx.review(r.reviewId,r);
        if(fail)throw Error('fixture outbox failure');
        for(const e of plan.records.outbox)await tx.enqueue(e.eventId,e);
        await tx.update('task',{...t,state:'closed'});
      }else if(kind==='count'){
        const session=await tx.lock('session');
        plan=planCountObservation({session,request:p,actorId,recordedAt:now});
        if(plan.status!=='planned')throw Error('invalid count');
        await tx.record(JSON.stringify(plan.identity),plan.records.observation);
      }else{
        const current=await tx.lock('reason');
        plan=planReasonRevision({current,next:p,actorId,recordedAt:now});
        if(plan.status!=='planned')throw Error('invalid revision');
        await tx.record(JSON.stringify(plan.identity),plan.records.reason);
        await tx.update('reason',plan.records.reason);
      }
      return {identity:plan.identity,status:'fixture-recorded'};
    }};
}
test('inventory PG: concurrent restock replay and distinct-key duplicate cannot double confirm',options,async()=>fixture(async f=>{
  const run=createLocalTransactionCandidate({...f,authorize:async()=>true});
  const c=command('restock',restock);
  const r=await Promise.all([run(c),run(c)]);
  assert.equal(r.filter(x=>x.replayed).length,1);
  await assert.rejects(run(command('restock',{...restock,batchId:'B2'},{commandKey:'fixture-002'})),/invalid task/);
  assert.equal((await f.read('task')).state,'closed');
  assert.deepEqual(await f.counts(),{commands:1,records:1,reviews:1,outbox:1,audit:1});
}));
test('inventory PG: confirmation/review/outbox rollback preserves open task',options,async()=>fixture(async f=>{
  const run=createLocalTransactionCandidate({...f,authorize:async()=>true});
  await assert.rejects(run(command('restock',restock,{fail:true})),/fixture outbox failure/);
  assert.equal((await f.read('task')).state,'open');
  assert.deepEqual(await f.counts(),{commands:0,records:0,reviews:0,outbox:0,audit:0});
  await run(command('restock',restock));
  assert.deepEqual(await f.counts(),{commands:1,records:1,reviews:1,outbox:1,audit:1});
}));
test('inventory PG: count identity and reason revision enforce uniqueness under different command keys',options,async()=>fixture(async f=>{
  const run=createLocalTransactionCandidate({...f,authorize:async()=>true});
  await run(command('count',count));
  await assert.rejects(run(command('count',count,{commandKey:'fixture-002'})),e=>e.code==='23505');
  const next={...reason,revision:2};
  const results=await Promise.allSettled([run(command('reason',next)),run(command('reason',next,{commandKey:'fixture-003'}))]);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
  assert.equal((await f.read('reason')).revision,2);
  assert.deepEqual(await f.counts(),{commands:2,records:2,reviews:0,outbox:0,audit:2});
}));
test('inventory PG: denial after claim and revoked replay preserve records',options,async()=>fixture(async f=>{
  let checks=0;
  const c=command('restock',restock);
  const deny=createLocalTransactionCandidate({...f,authorize:async()=>++checks===1});
  await assert.rejects(deny(c),e=>e.code==='CORE_FORBIDDEN');
  assert.deepEqual(await f.counts(),{commands:0,records:0,reviews:0,outbox:0,audit:1});
  let active=true;const run=createLocalTransactionCandidate({...f,authorize:async()=>active});
  await run(c);active=false;
  await assert.rejects(run(c),e=>e.code==='CORE_FORBIDDEN');
  assert.deepEqual(await f.counts(),{commands:1,records:1,reviews:1,outbox:1,audit:3});
}));
