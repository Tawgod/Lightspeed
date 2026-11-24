import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createLocalTransactionCandidate } from '../services/lightspeed/localTransactionCandidate.js';

// All tables are disposable fixtures, not migration candidates.
const uri=process.env.HC_TEST_DATABASE_URL;
const options={skip:!uri?'Disposable PostgreSQL required':false};
async function fixture(fn){
  const u=new URL(uri);
  if(!['127.0.0.1','localhost'].includes(u.hostname)||u.pathname!=='/hc_test'||u.username!=='hc_test')throw Error('Disposable local test DB required');
  const pool=new pg.Pool({connectionString:uri,max:8});
  const schema='fixture_'+randomUUID().replaceAll('-','');
  try{
    await pool.query('CREATE SCHEMA '+schema);
    await pool.query('CREATE TABLE '+schema+'.commands(scope text,key text,fingerprint text,result jsonb,PRIMARY KEY(scope,key)); CREATE TABLE '+schema+'.domain(id text PRIMARY KEY); CREATE TABLE '+schema+'.outbox(id text PRIMARY KEY); CREATE TABLE '+schema+'.audit(id bigint GENERATED ALWAYS AS IDENTITY, outcome text, key text)');
    const transaction=async work=>{
      const c=await pool.connect();
      try{
        await c.query('BEGIN');
        const tx={
          async claim({scope,key,fingerprint}){
            const insert=await c.query('INSERT INTO '+schema+'.commands(scope,key,fingerprint) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING key',[scope,key,fingerprint]);
            if(insert.rowCount===1)return {state:'claimed'};
            const r=(await c.query('SELECT fingerprint,result FROM '+schema+'.commands WHERE scope=$1 AND key=$2 FOR UPDATE',[scope,key])).rows[0];
            return r?.fingerprint===fingerprint&&r.result!==null?{state:'replay',result:r.result}:{state:'conflict'};
          },
          async complete({scope,key,fingerprint,result}){
            const r=await c.query('UPDATE '+schema+'.commands SET result=$4::jsonb WHERE scope=$1 AND key=$2 AND fingerprint=$3 AND result IS NULL',[scope,key,fingerprint,JSON.stringify(result)]);
            assert.equal(r.rowCount,1);
          },
          appendAudit:({key,outcome})=>c.query('INSERT INTO '+schema+'.audit(key,outcome) VALUES($1,$2)',[key,outcome]),
          writeDomain:id=>c.query('INSERT INTO '+schema+'.domain(id) VALUES($1)',[id]),
          enqueue:id=>c.query('INSERT INTO '+schema+'.outbox(id) VALUES($1)',[id])
        };
        const value=await work(tx);await c.query('COMMIT');return value;
      }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
    };
    const auditDenied=({key,outcome})=>pool.query('INSERT INTO '+schema+'.audit(key,outcome) VALUES($1,$2)',[key,outcome]);
    const counts=async()=>Object.fromEntries(await Promise.all(['commands','domain','outbox','audit'].map(async t=>[t,Number((await pool.query('SELECT count(*) FROM '+schema+'.'+t)).rows[0].count)])));
    await fn({transaction,auditDenied,counts});
  }finally{await pool.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await pool.end();}
}
const command={scope:'test:shop:restock.confirm',key:'fixture-001',operations:['restock.confirm'],context:{fixture:true},payload:{id:'batch-1'},apply:async(tx,p)=>{await tx.writeDomain(p.id);await tx.enqueue(p.id);return {id:p.id};}};
test('disposable PG: concurrent duplicate local command commits once, replays, conflicts',options,async()=>fixture(async f=>{
  const run=createLocalTransactionCandidate({...f,authorize:async()=>true});
  const results=await Promise.all([run(command),run(command)]);
  assert.equal(results.filter(x=>x.replayed).length,1);
  assert.deepEqual(await f.counts(),{commands:1,domain:1,outbox:1,audit:1});
  await assert.rejects(run({...command,payload:{id:'other'}}),e=>e.code==='CORE_KEY_CONFLICT');
  assert.deepEqual(await f.counts(),{commands:1,domain:1,outbox:1,audit:1});
}));
test('disposable PG: failure rolls back domain, outbox, claim and audit; retry succeeds',options,async()=>fixture(async f=>{
  const run=createLocalTransactionCandidate({...f,authorize:async()=>true});
  await assert.rejects(run({...command,apply:async(tx,p)=>{await tx.writeDomain(p.id);await tx.enqueue(p.id);throw Error('fixture failure');}}));
  assert.deepEqual(await f.counts(),{commands:0,domain:0,outbox:0,audit:0});
  await run(command);
  assert.deepEqual(await f.counts(),{commands:1,domain:1,outbox:1,audit:1});
}));
test('disposable PG: execution-time denial rolls back reservation and records denial separately',options,async()=>fixture(async f=>{
  let checks=0;const run=createLocalTransactionCandidate({...f,authorize:async()=>++checks===1});
  await assert.rejects(run(command),e=>e.code==='CORE_FORBIDDEN');
  assert.deepEqual(await f.counts(),{commands:0,domain:0,outbox:0,audit:1});
}));
test('disposable PG: revoked grant cannot replay previously successful result',options,async()=>fixture(async f=>{
  let active=true;const run=createLocalTransactionCandidate({...f,authorize:async()=>active});
  await run(command);active=false;
  await assert.rejects(run(command),e=>e.code==='CORE_FORBIDDEN');
  assert.deepEqual(await f.counts(),{commands:1,domain:1,outbox:1,audit:2});
}));
