import pg from 'pg';
import {randomUUID} from 'node:crypto';
// Dedicated disposable remote ledger; no production adapter, no callback inside a transaction.
export async function withRemoteM7Pg(work,{uri=process.env.HC_TEST_DATABASE_URL}={}){
 const u=new URL(uri);
 if(!['postgres:','postgresql:'].includes(u.protocol)||!['localhost','127.0.0.1'].includes(u.hostname)||u.pathname!=='/hc_test'||u.username!=='hc_test'||u.search||u.hash)throw Error('Disposable database required');
 const pool=new pg.Pool({connectionString:uri,max:8}),s='remote_m7_'+randomUUID().replaceAll('-','');
 const t=n=>s+'.'+n;
 const tx=async fn=>{const c=await pool.connect();try{await c.query('BEGIN');const r=await fn(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}};
 const where=m=>[m.tenant,m.key,m.digest,m.approvalDigest];
 const row=r=>r?{...r,digest:r.digest,approvalDigest:r.approval_digest,eventId:r.event_id}:null;
 const audit=(c,m,stage)=>c.query('INSERT INTO '+t('audit')+'(record) VALUES($1::jsonb)',[JSON.stringify({tenant:m.tenant,key:m.key,digest:m.digest,stage})]);
 try{
 await pool.query('CREATE SCHEMA '+s);
 await pool.query(`
 CREATE TABLE ${t('commands')}(tenant text,key text,digest text NOT NULL,approval_digest text NOT NULL,state text NOT NULL,event_id text,receipt jsonb,PRIMARY KEY(tenant,key));
 CREATE TABLE ${t('reservations')}(tenant text,identity text,key text NOT NULL,PRIMARY KEY(tenant,identity),FOREIGN KEY(tenant,key) REFERENCES ${t('commands')}(tenant,key));
 CREATE TABLE ${t('audit')}(record jsonb NOT NULL);
 CREATE FUNCTION ${s}.immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'immutable audit'; END; $$;
 CREATE TRIGGER immutable_audit BEFORE UPDATE OR DELETE OR TRUNCATE ON ${t('audit')} FOR EACH STATEMENT EXECUTE FUNCTION ${s}.immutable();
 `);
 const store={
 async reserve(m){
  try{return await tx(async c=>{
   const inserted=await c.query('INSERT INTO '+t('commands')+"(tenant,key,digest,approval_digest,state) VALUES($1,$2,$3,$4,'reserved') ON CONFLICT DO NOTHING RETURNING key",where(m));
   if(!inserted.rowCount){
    const r=row((await c.query('SELECT * FROM '+t('commands')+' WHERE tenant=$1 AND key=$2 FOR UPDATE',[m.tenant,m.key])).rows[0]);
    return r&&r.digest===m.digest&&r.approvalDigest===m.approvalDigest?r:{state:'conflict'};
   }
   for(const k of m.keys)await c.query('INSERT INTO '+t('reservations')+'(tenant,identity,key) VALUES($1,$2,$3)',[m.tenant,JSON.stringify(k),m.key]);
   await audit(c,m,'reserved');return {state:'claimed'};
  });}catch(e){if(e.code==='23505')return {state:'conflict'};throw e;}
 },
 async beginDispatch(m){return tx(async c=>{
  const r=await c.query('UPDATE '+t('commands')+" SET state='dispatching',event_id=$5 WHERE tenant=$1 AND key=$2 AND digest=$3 AND approval_digest=$4 AND state='reserved'",[...where(m),m.eventId]);
  if(r.rowCount!==1)throw Error('Dispatch not reserved');await audit(c,m,'requested');
 });},
 async lookup(m){return row((await pool.query('SELECT * FROM '+t('commands')+' WHERE tenant=$1 AND key=$2 AND digest=$3 AND approval_digest=$4',where(m))).rows[0]);},
 async mark(m){return tx(async c=>{
  if(!['blocked','unknown','verified'].includes(m.state))throw Error('Invalid state');
  const from=m.state==='blocked'?['reserved']:m.state==='unknown'?['dispatching','unknown']:['dispatching','unknown'];
  const r=await c.query('UPDATE '+t('commands')+' SET state=$5,receipt=$6::jsonb WHERE tenant=$1 AND key=$2 AND digest=$3 AND approval_digest=$4 AND state=ANY($7::text[])',[...where(m),m.state,JSON.stringify(m.receipt??null),from]);
  if(r.rowCount!==1)throw Error('State transition not confirmed');await audit(c,m,m.state);
 });},
 appendAudit:m=>audit(pool,m,m.stage)
 };
 await work({store,counts:async()=>Object.fromEntries(await Promise.all(['commands','reservations','audit'].map(async n=>[n,Number((await pool.query('SELECT count(*) FROM '+t(n))).rows[0].count)]))),tamper:()=>pool.query('DELETE FROM '+t('audit'))});
 }finally{try{await pool.query('DROP SCHEMA IF EXISTS '+s+' CASCADE');}finally{await pool.end();}}
}
