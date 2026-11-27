// Server-only composition. No routes, fixture imports, identity discovery or grants.
import {createScannerSessions} from '../scannerSessions.js';
import {withAuthorityFence} from './authorityFence.js';
import {randomUUID} from 'node:crypto';
const V='HC-SECURE-READ/0.1';
const ident=x=>typeof x==='string'&&/^[A-Za-z0-9_.:-]{1,150}$/.test(x)&&x!=='unknown';
const exact=(x,k)=>x&&Object.getPrototypeOf(x)===Object.prototype&&Object.keys(x).length===k.length&&k.every(y=>Object.hasOwn(x,y));
const id=x=>typeof x==='string'&&/^[1-9][0-9]{0,15}$/.test(x)&&Number.isSafeInteger(Number(x));
const denied=()=>Object.assign(Error('Access denied'),{status:403});
const unavailable=()=>Object.assign(Error('Unavailable'),{status:503});
const keys=['version','requestId','operation','tenant','environment','audience','location','resourceType','resourceId','variantId','sourceRevision','sourceRef','fields','purpose'];
const fields=['productId','variantId','name'];
const one=async(c,q,p=[])=>{const r=await c.query(q,p);return r.rowCount===1?r.rows[0]:null};
// Adapters are injected only at trusted server composition, never from a request.
// Disabled by default; actual Timeclock/factor/site adapters require separate approval.
export function createOperationalRead({pool,secret,tenant,environment,audience,operation,identity,throttle,verifyAssurance,admitSource,evaluatePolicy,enabled=false,clock=Date.now}={}){
 if(![tenant,environment,audience,operation].every(ident)||!pool?.connect)throw TypeError('Exact configuration required');
 const tokens=createScannerSessions({secret,now:clock,ttlSeconds:900});
 const handles=new WeakMap();
 const ready=()=>{if(enabled!==true||![identity?.verifyPin,identity?.authorize,throttle?.reserve,verifyAssurance,admitSource,evaluatePolicy].every(x=>typeof x==='function'))throw unavailable()};
 const epoch=async c=>{const e=await one(c,'SELECT policy_revision,evidence_revision FROM hc_security_operational.authority WHERE singleton');if(!e)throw unavailable();return e};
 const active=async employeeId=>{const person=await identity.authorize(employeeId);if(!exact(person,['id','active','employeeNumber'])||person.id!==employeeId||person.active!==true||!(person.employeeNumber===null||typeof person.employeeNumber==='string'))throw denied();};
 const audit=(c,actor,requestId,outcome)=>c.query('INSERT INTO hc_security_operational.audit(id,actor,request_id,outcome,at_ms) VALUES($1,$2,$3,$4,$5)',[randomUUID(),actor,requestId,outcome,clock()]);
 // This method is server-only. sourceIp must come from verified transport.
 async function issue({employeeId,pin,sourceIp}={}){
 ready();if(!id(employeeId)||typeof pin!=='string'||!/^\d{4}$/.test(pin))throw denied();
 if(!await throttle.reserve({employeeId,sourceIp}))throw denied();
 const person=await identity.verifyPin(employeeId,pin);
 if(!exact(person,['id','active','employeeNumber'])||person.id!==employeeId||person.active!==true||!(person.employeeNumber===null||typeof person.employeeNumber==='string'))throw denied();
 return withAuthorityFence(pool,async c=>{
 await active(employeeId);const e=await epoch(c);
 const p=await one(c,'SELECT active FROM hc_security_operational.employee WHERE id=$1',[employeeId]);if(p?.active!==true)throw denied();
 const token=tokens.issue({id:employeeId}),b=tokens.verifyBound(token);
 await c.query('INSERT INTO hc_security_operational.session(id,employee_id,policy_revision,evidence_revision,expires_at) VALUES($1,$2,$3,$4,$5)',[b.sessionId,employeeId,e.policy_revision,e.evidence_revision,b.expiresAtMs]);
 await audit(c,employeeId,b.sessionId,'issued');return {token,expiresAt:b.expiresAtMs};
 });
 }
 async function current(c,token,transport){
 const b=tokens.verifyBound(token),employeeId=String(b.employeeId);await active(employeeId);
 const e=await epoch(c),p=await one(c,'SELECT active,policy FROM hc_security_operational.employee WHERE id=$1',[employeeId]),s=await one(c,'SELECT * FROM hc_security_operational.session WHERE id=$1',[b.sessionId]);
 if(p?.active!==true||!s||s.employee_id!==employeeId||s.revoked||s.policy_revision!==e.policy_revision||s.evidence_revision!==e.evidence_revision||Number(s.expires_at)!==b.expiresAtMs||clock()>=b.expiresAtMs)throw denied();
 const proof=await verifyAssurance({employeeId,sessionId:b.sessionId,tenant,environment,audience,transport});
 if(!exact(proof,['deviceId','siteId','method','expiresAt'])||!ident(proof.deviceId)||!(proof.siteId===null||ident(proof.siteId))||!['timeclock-pin','strong'].includes(proof.method)||proof.siteId===null&&proof.method!=='strong'||!Number.isSafeInteger(proof.expiresAt)||proof.expiresAt<=clock())throw denied();
 return {employeeId,sessionId:b.sessionId,policy:p.policy,policyRevision:e.policy_revision,evidenceRevision:e.evidence_revision,deviceId:proof.deviceId,siteId:proof.siteId,method:proof.method,expiresAt:Math.min(proof.expiresAt,b.expiresAtMs)};
 }
 async function context(token,transport){
 ready();const state=await withAuthorityFence(pool,c=>current(c,token,transport));
 const handle=Object.freeze(Object.create(null));handles.set(handle,{token,transport,state});return handle;
 }
 const same=(a,b)=>['employeeId','sessionId','policyRevision','evidenceRevision','deviceId','siteId','method','expiresAt'].every(k=>a[k]===b[k]);
 const valid=q=>exact(q,keys)&&q.version===V&&keys.filter(k=>!['version','variantId','fields'].includes(k)).every(k=>ident(q[k]))&&q.tenant===tenant&&q.environment===environment&&q.audience===audience&&q.operation===operation&&q.resourceType==='product'&&(q.variantId===null||ident(q.variantId))&&Array.isArray(q.fields)&&q.fields.length===3&&fields.every(f=>q.fields.includes(f));
 async function read(handle,input){
 let q;try{q=structuredClone(input)}catch{}
 const requestId=ident(q?.requestId)?q.requestId:null;
 const reply=(status,data=null)=>({version:V,requestId,status,data});
 try{
 ready();const h=handles.get(handle);if(!h||!valid(q))return reply('denied');
 return await withAuthorityFence(pool,async c=>{
 const s=await current(c,h.token,h.transport);if(!same(s,h.state))return reply('stale');
 const permitted=async state=>{for(const field of fields)for(const stage of ['read','projection'])if(await evaluatePolicy({actor:{realm:'employee',id:state.employeeId,tenant,environment},policy:structuredClone(state.policy),policyRevision:state.policyRevision,effect:{...q,fields:[field]},stage,now:clock()})!==true)return false;return true};
 if(!await permitted(s)){await audit(c,s.employeeId,requestId,'denied');return reply('denied')}
 const source=await admitSource(structuredClone(q));
 if(!source||source.status!=='observed'||source.complete!==true||!exact(source.scope,keys)||JSON.stringify(keys.map(k=>source.scope[k]))!==JSON.stringify(keys.map(k=>q[k])))return reply('unavailable');
 const d=source.data;if(!exact(d,fields)||d.productId!==q.resourceId||d.variantId!==q.variantId||typeof d.name!=='string'||!d.name.trim()||d.name.length>300)return reply('unavailable');
 const out={productId:d.productId,variantId:d.variantId,name:d.name};
 const end=await current(c,h.token,h.transport);if(!same(s,end)||!await permitted(end))return reply('stale');
 await audit(c,s.employeeId,requestId,'read');if(clock()>=end.expiresAt)return reply('stale');return reply('ok',out);
 });
 }catch(e){return reply(e.status===401||e.status===403?'denied':'unavailable')}
 }
 // Self logout only; administration revocation belongs to separate authorized writer.
 async function logout(handle){ready();const h=handles.get(handle);if(!h)throw denied();handles.delete(handle);return withAuthorityFence(pool,async c=>{const b=tokens.verifyBound(h.token);await c.query('UPDATE hc_security_operational.session SET revoked=true WHERE id=$1 AND employee_id=$2',[b.sessionId,String(b.employeeId)]);await audit(c,String(b.employeeId),b.sessionId,'logout');});}
 return Object.freeze({issue,context,read,logout});
}
