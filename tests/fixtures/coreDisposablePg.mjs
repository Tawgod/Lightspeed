import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { fingerprintLightspeedPayload as fingerprint } from '../../services/lightspeed/idempotency.js';

// Reusable disposable fixture only. Never import from a runtime service.
// A unique schema is isolated per test; no external I/O or vendor callbacks.
export async function withDisposableCorePg(work,{uri=process.env.HC_TEST_DATABASE_URL}={}){
  const u=new URL(uri);
  if(!['postgres:','postgresql:'].includes(u.protocol)||!['127.0.0.1','localhost'].includes(u.hostname)||
    u.pathname!=='/hc_test'||u.username!=='hc_test'||u.search||u.hash)throw Error('Explicit local disposable hc_test required.');
  const pool=new pg.Pool({connectionString:uri,max:8});
  const schema='core_fixture_'+randomUUID().replaceAll('-','');
  const table=name=>schema+'.'+name;
  try{
    await pool.query('CREATE SCHEMA '+schema);
    await pool.query(`
      CREATE TABLE ${table('commands')}(scope text,key text,fingerprint text,result jsonb,PRIMARY KEY(scope,key));
      CREATE TABLE ${table('domain')}(id text PRIMARY KEY,record jsonb NOT NULL);
      CREATE TABLE ${table('typed_locks')}(kind text,id text,PRIMARY KEY(kind,id));
      CREATE TABLE ${table('typed_domain')}(kind text,id text,revision integer NOT NULL,record jsonb NOT NULL,PRIMARY KEY(kind,id));
      CREATE TABLE ${table('outbox')}(id text PRIMARY KEY,fingerprint text NOT NULL,record jsonb NOT NULL);
      CREATE TABLE ${table('audit')}(id bigint GENERATED ALWAYS AS IDENTITY,record jsonb NOT NULL);
      CREATE FUNCTION ${schema}.immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture audit immutable'; END; $$;
      CREATE TRIGGER immutable_audit BEFORE UPDATE OR DELETE OR TRUNCATE ON ${table('audit')} FOR EACH STATEMENT EXECUTE FUNCTION ${schema}.immutable();
    `);
    const append=(client,meta)=>client.query('INSERT INTO '+table('audit')+'(record) VALUES($1::jsonb)',[JSON.stringify(meta)]);
    const transaction=async (fn,{targets}={})=>{
      const client=await pool.connect();
      let committing=false;
      try{
        await client.query('BEGIN');
        const held=new Set(),allowed=new Set((targets??[]).map(t=>JSON.stringify([t.type,t.id])));
        const k=t=>JSON.stringify([t.type,t.id]);
        const requireHeld=t=>{if(!held.has(k(t)))throw Error('Undeclared or unlocked typed target');};
        const tx={
          async lockDomain(t){
            if(!allowed.has(k(t)))throw Error('Undeclared typed target');
            await client.query('INSERT INTO '+table('typed_locks')+'(kind,id) VALUES($1,$2) ON CONFLICT DO NOTHING',[t.type,t.id]);
            await client.query('SELECT id FROM '+table('typed_locks')+' WHERE kind=$1 AND id=$2 FOR UPDATE',[t.type,t.id]);
            held.add(k(t));
            return (await client.query('SELECT revision,record FROM '+table('typed_domain')+' WHERE kind=$1 AND id=$2',[t.type,t.id])).rows[0]??null;
          },
          async insertDomain({type,id,record}){requireHeld({type,id});const r=await client.query('INSERT INTO '+table('typed_domain')+'(kind,id,revision,record) VALUES($1,$2,1,$3::jsonb) RETURNING revision',[type,id,JSON.stringify(record)]);return r.rows[0].revision;},
          async replaceDomain({type,id,expectedRevision,record}){requireHeld({type,id});const r=await client.query('UPDATE '+table('typed_domain')+' SET revision=revision+1,record=$4::jsonb WHERE kind=$1 AND id=$2 AND revision=$3 RETURNING revision',[type,id,expectedRevision,JSON.stringify(record)]);if(r.rowCount!==1)throw Object.assign(Error('Stale typed revision'),{code:'CORE_REVISION_CONFLICT'});return r.rows[0].revision;},
          async enqueueCanonical({id,record}){return tx.enqueue({id,fingerprint:fingerprint({id,record}),record});},
          async claim({scope,key,fingerprint}){
            const insert=await client.query('INSERT INTO '+table('commands')+'(scope,key,fingerprint) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING key',[scope,key,fingerprint]);
            if(insert.rowCount===1)return {state:'claimed'};
            const row=(await client.query('SELECT fingerprint,result FROM '+table('commands')+' WHERE scope=$1 AND key=$2 FOR UPDATE',[scope,key])).rows[0];
            return row?.fingerprint===fingerprint&&row.result!==null?{state:'replay',result:row.result}:{state:'conflict'};
          },
          async complete({scope,key,fingerprint,result}){
            const r=await client.query('UPDATE '+table('commands')+' SET result=$4::jsonb WHERE scope=$1 AND key=$2 AND fingerprint=$3 AND result IS NULL',[scope,key,fingerprint,JSON.stringify(result)]);
            if(r.rowCount!==1)throw Error('Fixture completion unconfirmed.');
          },
          appendAudit:meta=>append(client,meta),
          writeDomain:(id,record)=>client.query('INSERT INTO '+table('domain')+'(id,record) VALUES($1,$2::jsonb)',[id,JSON.stringify(record)]),
          async enqueue({id,fingerprint,record}){
            const r=await client.query('INSERT INTO '+table('outbox')+'(id,fingerprint,record) VALUES($1,$2,$3::jsonb) ON CONFLICT DO NOTHING RETURNING id',[id,fingerprint,JSON.stringify(record)]);
            if(r.rowCount===1)return {duplicate:false};
            const prior=(await client.query('SELECT fingerprint FROM '+table('outbox')+' WHERE id=$1 FOR UPDATE',[id])).rows[0];
            if(prior?.fingerprint!==fingerprint)throw Object.assign(Error('Fixture outbox conflict.'),{code:'CORE_OUTBOX_CONFLICT'});
            return {duplicate:true};
          }
        };
        const result=await fn(tx);
        committing=true;
        await client.query('COMMIT');
        return result;
      }catch(error){
        if(committing)throw Object.assign(Error('Commit acknowledgement uncertain.'),{code:'CORE_COMMIT_UNKNOWN'});
        await client.query('ROLLBACK');
        throw error;
      }finally{client.release(committing?new Error('Discard fixture commit connection'):undefined);}
    };
    const inspectCommitted=async({scope,key})=>{
      const r=(await pool.query('SELECT fingerprint,result FROM '+table('commands')+' WHERE scope=$1 AND key=$2',[scope,key])).rows[0];
      return r&&r.result!==null?{state:'committed',fingerprint:r.fingerprint,result:r.result}:{state:'unknown'};
    };
    const typedCounts=async()=>Object.fromEntries(await Promise.all(['typed_domain','typed_locks'].map(async name=>[name,Number((await pool.query('SELECT count(*) FROM '+table(name))).rows[0].count)])));
    const counts=async()=>Object.fromEntries(await Promise.all(['commands','domain','outbox','audit'].map(async name=>[name,Number((await pool.query('SELECT count(*) FROM '+table(name))).rows[0].count)])));
    await work({transaction,inspectCommitted,auditDenied:meta=>append(pool,meta),counts,typedCounts,
      attemptAuditUpdate:()=>pool.query('UPDATE '+table('audit')+' SET record=record'),
      attemptAuditDelete:()=>pool.query('DELETE FROM '+table('audit')),
      attemptAuditTruncate:()=>pool.query('TRUNCATE '+table('audit'))});
  }finally{try{await pool.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');}finally{await pool.end();}}
}
