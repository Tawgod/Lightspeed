import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {readFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {createScannerSessions} from '../services/scannerSessions.js';
import {createPgRuntime,disposableCommandDigest} from './security-runtime/s25mPgRuntime.mjs';
const config={host:'127.0.0.1',port:5432,database:'hc_s25m_disposable'};
test('disposable PostgreSQL authority, transaction, audit and independent inspection',async()=>{
 assert.equal(process.env.HC_S25M_DISPOSABLE,'yes');
 const admin=new pg.Pool({...config,user:'postgres',password:'disposable-only'});
 const runtime=new pg.Pool({...config,user:'hc_s25m_runtime',password:'disposable-runtime-only'});
 const secret=randomBytes(48).toString('hex');let now=Date.now();
 const tenant='fictional-hc',environment='test',location='fictional-store';
 const ops=['test.tool.read','test.tool.write','test.tool.receipt.inspect'];
 const rule=(id,operation,kind='grant',resourceId='sample-1')=>({id,kind,effect:{operation,tenant,environment,location,resourceType:'fictional-note',resourceId,field:'label'},startsAt:0,expiresAt:8640000000000000,revoked:false});
 const role=(id,...rules)=>({id,active:true,rules});
 const personas={'101':[role('owner',rule('a',ops[0]),rule('b',ops[2]))],'102':[role('manager',rule('a',ops[0]),rule('b',ops[1]))],'103':[role('employee',rule('a',ops[0]))],'104':[role('one',rule('a',ops[0])),role('two',rule('b',ops[0],'grant','sample-2'))],'105':[role('employee',rule('a',ops[0]))],'106':[role('employee',rule('a',ops[0]))]};
 const tokens=createScannerSessions({secret,now:()=>now,ttlSeconds:900});
 const q=(sql,p=[])=>admin.query(sql,p);
 async function provision(id,{offsite=false,allowed=false,expired=false}={}){
 const token=tokens.issue({id}),b=tokens.verifyBound(token),deviceId='d-'+id,life={active:true,revoked:false,startsAt:b.issuedAtMs,expiresAt:expired?now:b.expiresAtMs};
 const evidence={session:{...life,id:b.sessionId,actorId:id,tenant,deviceId,locked:false,method:offsite?'strong':'timeclock-pin',offsiteAllowed:allowed},device:{...life,id:deviceId,tenant,kind:'personal',actorId:id},site:offsite?null:{...life,id:'site-'+id,tenant,deviceId,sessionId:b.sessionId,verified:true,networkClass:'trusted-store'},strongProof:offsite?{...life,actorId:id,tenant,deviceId,sessionId:b.sessionId,verifiedAt:now}:null};
 await q('INSERT INTO hc_s25m.session SELECT $1,$2,policy_revision,evidence_revision,$3,false FROM hc_s25m.authority',[b.sessionId,id,JSON.stringify(evidence)]);return {header:'Bearer '+token,binding:b.sessionId};
 }
 try{
 const check=await q("SELECT current_database() db,host(inet_server_addr()) addr");assert.equal(check.rows[0].db,config.database);assert.match(check.rows[0].addr,/^(127\.0\.0\.1|172\.(1[6-9]|2[0-9]|3[01])\.[0-9]{1,3}\.[0-9]{1,3})$/);
 await q(await readFile(new URL('./security-runtime/s25m-disposable.sql',import.meta.url),'utf8'));
 await q("CREATE ROLE hc_s25m_runtime LOGIN PASSWORD 'disposable-runtime-only'");
 await q('GRANT USAGE ON SCHEMA hc_s25m TO hc_s25m_runtime; GRANT SELECT ON ALL TABLES IN SCHEMA hc_s25m TO hc_s25m_runtime; GRANT UPDATE ON hc_s25m.authority,hc_s25m.note TO hc_s25m_runtime; GRANT INSERT ON hc_s25m.receipt,hc_s25m.audit TO hc_s25m_runtime');
 for(const [id,roles] of Object.entries(personas)){const policy={tenant,environment,version:'v1',roles,assignments:roles.map((r,i)=>({id:'m'+i,actorId:id,roleId:r.id,startsAt:0,expiresAt:8640000000000000,revoked:false})),individual:id==='105'?[{actorId:id,rule:rule('restriction',ops[0],'restrict')}]:[]};await q('INSERT INTO hc_s25m.employee VALUES($1,$2,$3)',[id,id!=='106',JSON.stringify(policy)])}
 await q("INSERT INTO hc_s25m.note VALUES('sample-1','Original',1),('sample-2','Other',1)");
 const r=await createPgRuntime({pool:runtime,secret,clock:()=>now,testOnly:true});
 await assert.rejects(createPgRuntime({pool:admin,secret,testOnly:true}));
 await assert.rejects(runtime.query("DELETE FROM hc_s25m.audit"));
 await assert.rejects(runtime.query("UPDATE hc_s25m.employee SET active=true"));
 const owner=await provision('101'),manager=await provision('102'),ordinary=await provision('103'),multi=await provision('104'),restricted=await provision('105'),inactive=await provision('106'),expired=await provision('103',{expired:true}),remote=await provision('103',{offsite:true,allowed:true}),badRemote=await provision('103',{offsite:true});
 const note='/test/notes/sample-1',other='/test/notes/sample-2',receipt='/test/receipts/k1';
 const get=(p,path=note)=>r.request(p?.header,'GET',path);
 for(const p of [owner,manager,ordinary,multi,remote])assert.equal((await get(p)).status,200);
 for(const p of [restricted,inactive,expired,badRemote])assert.equal((await get(p)).status,403);
 assert.equal((await get()).status,401);assert.equal((await get({header:owner.header+'x'})).status,401);assert.equal((await get(owner,other)).status,403);assert.equal((await get(multi,other)).status,200);
 await q('INSERT INTO hc_s25m.approval VALUES($1,$2,$3,$4,$5,false)',['a1','102','101',disposableCommandDigest('102','sample-1','Updated',1),now+60000]);
 const body={label:'Updated',expectedRevision:1,approvalRef:'a1',key:'k1'};
 const post=(p,b=body)=>r.request(p.header,'POST',note,b);
 assert.equal((await post(ordinary)).status,403);assert.equal((await post(owner)).status,403);assert.equal((await post(manager,{...body,label:'Substituted'})).status,403);
 const simultaneous=await Promise.all([post(manager),post(manager)]);assert.deepEqual(simultaneous.map(x=>x.data.replayed).sort(),[false,true]);
 assert.equal((await post(manager,{...body,key:'k2'})).status,409);
 assert.equal((await get(ordinary)).data.label,'Updated');assert.equal((await get(manager,receipt)).status,403);
 // Cooperative operator updates share the same authority lock as requests.
 const operator=await admin.connect();try{await operator.query('BEGIN');await operator.query('SELECT * FROM hc_s25m.authority FOR UPDATE');await operator.query('UPDATE hc_s25m.session SET revoked=true WHERE id=$1',[manager.binding]);const pending=post(manager);await operator.query('COMMIT');assert.equal((await pending).status,403)}finally{operator.release()}
 assert.deepEqual((await get(owner,receipt)).data,{revision:2,outcome:'committed',retryAllowed:false});
 await q('UPDATE hc_s25m.authority SET evidence_revision=evidence_revision+1');assert.equal((await get(owner)).status,403);
 const fresh=await provision('101');assert.equal((await get(fresh)).status,200);
 await q("BEGIN; UPDATE hc_s25m.authority SET policy_revision=policy_revision+1; UPDATE hc_s25m.employee SET policy=jsonb_set(policy,'{version}','\"v2\"'); COMMIT");
 assert.equal((await get(fresh)).status,403);const current=await provision('101');assert.equal((await get(current)).status,200);now+=901000;assert.equal((await get(current)).status,401);
 const counts=await q("SELECT (SELECT count(*)::int FROM hc_s25m.receipt) receipts,(SELECT count(*)::int FROM hc_s25m.audit WHERE outcome='committed') commits,(SELECT count(*)::int FROM hc_s25m.audit WHERE outcome='denied') denied");
 assert.equal(counts.rows[0].receipts,1);assert.equal(counts.rows[0].commits,1);assert.ok(counts.rows[0].denied>0);
 const reopened=new pg.Pool({...config,user:'hc_s25m_runtime',password:'disposable-runtime-only'});try{const again=await createPgRuntime({pool:reopened,secret,clock:()=>now,testOnly:true});const newOwner=await provision('101');assert.deepEqual((await again.request(newOwner.header,'GET',receipt)).data,{revision:2,outcome:'committed',retryAllowed:false})}finally{await reopened.end()}
 }finally{await runtime.end();await admin.end()}
});
