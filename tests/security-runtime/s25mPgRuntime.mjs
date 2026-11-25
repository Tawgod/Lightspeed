// Disposable PostgreSQL composition, NOT a hosted entrypoint or identity issuer.
import {createScannerSessions} from '../../services/scannerSessions.js';
import {createSyntheticRoleEvaluator} from '../fixtures/hc-secure-s25e-role-policy.mjs';
import {evaluateSyntheticAssurance} from '../fixtures/hc-secure-s25g-lifecycle.mjs';
import {randomUUID,createHash} from 'node:crypto';
const tenant='fictional-hc',environment='test',location='fictional-store';
const ops=['test.tool.read','test.tool.write','test.tool.receipt.inspect'];
const evaluate=createSyntheticRoleEvaluator(ops);
const effect=(operation,resourceId)=>({operation,tenant,environment,location,resourceType:'fictional-note',resourceId,field:'label'});
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const deny=(status=403)=>Object.assign(Error('Request denied'),{status});
const key=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(x);
const exact=(x,ks)=>x&&Object.getPrototypeOf(x)===Object.prototype&&Object.keys(x).length===ks.length&&ks.every(k=>Object.hasOwn(x,k));
const one=async(c,q,p=[])=>{const r=await c.query(q,p);return r.rowCount===1?r.rows[0]:null};
export async function createPgRuntime({pool,secret,clock=Date.now,testOnly=false}={}){
 if(testOnly!==true||process.env.NODE_ENV!=='test'||!pool?.connect)throw deny();
 const tokens=createScannerSessions({secret,ttlSeconds:900,now:clock});
 const client=await pool.connect();
 try{
 const p=await one(client,`SELECT current_database() db,current_user role,inet_server_addr()::text addr,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls,rolreplication,has_schema_privilege(current_user,'hc_s25m','CREATE') AS ddl FROM pg_roles WHERE rolname=current_user`);
 if(p?.db!=='hc_s25m_disposable'||p.role!=='hc_s25m_runtime'||!['127.0.0.1','::1'].includes(p.addr)||['rolsuper','rolcreatedb','rolcreaterole','rolbypassrls','rolreplication','ddl'].some(k=>p[k]!==false))throw deny();
 for(const table of ['authority','employee','session','approval','note','receipt','audit']){
 const row=await one(client,`SELECT has_table_privilege(current_user,$1,'SELECT') r,has_table_privilege(current_user,$1,'DELETE') d,has_table_privilege(current_user,$1,'TRUNCATE') t,has_table_privilege(current_user,$1,'UPDATE') u,has_table_privilege(current_user,$1,'INSERT') i`,['hc_s25m.'+table]);
 if(!row||row.r!==true||row.d||row.t||row.u!==['authority','note'].includes(table)||row.i!==['receipt','audit'].includes(table))throw deny();
 }
 }finally{client.release()}
 async function transaction(fn){
 const c=await pool.connect();let committing=false;
 try{await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='3s'");await c.query("SET LOCAL statement_timeout='5s'");
 // Serialize current authorization and all cooperative authority changes.
 const epoch=await one(c,'SELECT policy_revision,evidence_revision FROM hc_s25m.authority WHERE singleton=true FOR UPDATE');
 if(!epoch)throw deny();
 const out=await fn(c,epoch);committing=true;await c.query('COMMIT');return out;
 }catch(e){await c.query('ROLLBACK').catch(()=>{});if(committing)throw Object.assign(Error('Commit outcome unknown'),{status:503,unknown:true});throw e}finally{c.release()}
 }
 const audit=(c,e,actor,op,resource,outcome)=>c.query('INSERT INTO hc_s25m.audit VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[randomUUID(),actor,op,resource,outcome,e.policy_revision,e.evidence_revision,clock()]);
 async function authenticate(c,e,header){
 if(typeof header!=='string'||!header.startsWith('Bearer '))throw deny(401);
 let b;try{b=tokens.verifyBound(header.slice(7))}catch{throw deny(401)}
 const id=String(b.employeeId),p=await one(c,'SELECT active,policy FROM hc_s25m.employee WHERE id=$1',[id]),s=await one(c,'SELECT * FROM hc_s25m.session WHERE id=$1',[b.sessionId]);
 if(p?.active!==true||!s||s.employee_id!==id||s.revoked||s.policy_revision!==e.policy_revision||s.evidence_revision!==e.evidence_revision||s.evidence?.session?.id!==b.sessionId||s.evidence?.session?.expiresAt>b.expiresAtMs||p.policy?.version!=='v'+e.policy_revision)throw deny();
 return {id,employee:{realm:'employee',id,tenant,active:true},policy:p.policy,evidence:s.evidence,expires:b.expiresAtMs};
 }
 function authorize(ctx,op,resource){
 const now=clock();
 if(now>=ctx.expires||!evaluateSyntheticAssurance({actor:ctx.employee,...ctx.evidence,now,mode:'business'}).allowed||!evaluate({actor:ctx.employee,effect:effect(op,resource),snapshot:ctx.policy,now}).allowed)throw deny();
 }
 const commandDigest=(actor,resource,label,revision)=>hash({actor,tenant,environment,resource,label,revision,effects:[effect(ops[1],resource)]});
 async function request(header,method,path,body){
 let actor=null,op='test.unknown',resource=null;
 try{return await transaction(async(c,e)=>{
 const ctx=await authenticate(c,e,header);actor=ctx.id;
 const n=/^\/test\/notes\/(sample-[12])$/.exec(path),r=/^\/test\/receipts\/([A-Za-z0-9_-]{1,80})$/.exec(path);
 if(method==='GET'&&n){op=ops[0];resource=n[1];authorize(ctx,op,resource);const row=await one(c,'SELECT label,revision FROM hc_s25m.note WHERE id=$1',[resource]);if(!row)throw deny();authorize(ctx,op,resource);await audit(c,e,actor,op,resource,'allowed');return {status:200,data:row}}
 if(method==='GET'&&r){op=ops[2];const row=await one(c,'SELECT * FROM hc_s25m.receipt WHERE key=$1',[r[1]]);if(!row||row.actor===actor)throw deny();resource=row.resource;authorize(ctx,op,resource);await audit(c,e,actor,op,resource,'allowed');return {status:200,data:{revision:row.revision,outcome:'committed',retryAllowed:false}}}
 if(method!=='POST'||!n)throw deny();
 op=ops[1];resource=n[1];
 if(!exact(body,['label','expectedRevision','approvalRef','key'])||typeof body.label!=='string'||!body.label.trim()||body.label.length>80||!Number.isSafeInteger(body.expectedRevision)||!key(body.approvalRef)||!key(body.key))throw deny(400);
 authorize(ctx,op,resource);authorize(ctx,ops[0],resource);
 const digest=commandDigest(actor,resource,body.label,body.expectedRevision);
 const p=await one(c,'SELECT a.*,e.active reviewer_active FROM hc_s25m.approval a JOIN hc_s25m.employee e ON e.id=a.reviewer WHERE a.id=$1',[body.approvalRef]);
 if(!p||p.actor!==actor||p.reviewer===actor||p.digest!==digest||p.revoked||Number(p.expires_at)<=clock()||p.reviewer_active!==true)throw deny();
 const prior=await one(c,'SELECT * FROM hc_s25m.receipt WHERE key=$1',[body.key]);
 if(prior){if(prior.actor!==actor||prior.digest!==digest||prior.approval_id!==p.id)throw deny(409);authorize(ctx,op,resource);authorize(ctx,ops[0],resource);await audit(c,e,actor,op,resource,'replayed');return {status:200,data:{revision:prior.revision,replayed:true}}}
 const row=await one(c,'SELECT revision FROM hc_s25m.note WHERE id=$1 FOR UPDATE',[resource]);if(row?.revision!==body.expectedRevision)throw deny(409);
 authorize(ctx,op,resource);authorize(ctx,ops[0],resource);if(Number(p.expires_at)<=clock())throw deny();
 await c.query('UPDATE hc_s25m.note SET label=$1,revision=revision+1 WHERE id=$2',[body.label,resource]);
 await c.query('INSERT INTO hc_s25m.receipt VALUES($1,$2,$3,$4,$5,$6)',[body.key,actor,digest,p.id,resource,row.revision+1]);
 await audit(c,e,actor,op,resource,'committed');
 authorize(ctx,op,resource);authorize(ctx,ops[0],resource);if(Number(p.expires_at)<=clock())throw deny();
 return {status:200,data:{revision:row.revision+1,replayed:false}};
 })}catch(e){if(!e.unknown)try{await transaction((c,v)=>audit(c,v,actor,op,resource,'denied'))}catch{}return {status:e.status||503,data:e.unknown?{error:'Outcome unknown; independently inspect. Do not retry.'}:{error:'Request denied'}}}
 }
 return Object.freeze({request});
}
export function disposableCommandDigest(actor,resource,label,revision){return hash({actor,tenant,environment,resource,label,revision,effects:[effect(ops[1],resource)]})}
