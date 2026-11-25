// Isolated disposable test runtime ONLY. No production imports/mount, no login route.
// Reuse existing signed staff sessions and exact inherited Security policy/assurance evaluator.
import {DatabaseSync} from 'node:sqlite';
import {createServer} from 'node:http';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {createScannerSessions} from '../../services/scannerSessions.js';
import {createSyntheticRoleEvaluator} from '../fixtures/hc-secure-s25e-role-policy.mjs';
import {evaluateSyntheticAssurance} from '../fixtures/hc-secure-s25g-lifecycle.mjs';
const tenant='fictional-hc',environment='test',location='fictional-store';
const ops=['test.tool.read','test.tool.write','test.tool.receipt.inspect'];
const evaluate=createSyntheticRoleEvaluator(ops);
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const effect=(operation,resourceId='sample-1')=>({operation,tenant,environment,location,resourceType:'fictional-note',resourceId,field:'label'});
const fail=(status=403)=>Object.assign(Error('Request denied'),{status});
const validKey=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(x);
const exact=(x,keys)=>x&&Object.getPrototypeOf(x)===Object.prototype&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
export function createDisposableSecurityRuntime({filename=':memory:',clock=Date.now,secret=randomBytes(48).toString('hex'),testOnly=false}={}){
 if(testOnly!==true||process.env.NODE_ENV!=='test'||(filename!==':memory:'&&!/^\/tmp\/hc-secure-s25l-[A-Za-z0-9_-]+\/test\.sqlite$/.test(filename)))throw Error('Disposable test runtime only');
 const db=new DatabaseSync(filename);
 db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;
 CREATE TABLE IF NOT EXISTS epoch(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
 INSERT OR IGNORE INTO epoch VALUES(1,1);
 CREATE TABLE IF NOT EXISTS employee(id TEXT PRIMARY KEY, active INTEGER NOT NULL CHECK(active IN(0,1)));
 CREATE TABLE IF NOT EXISTS policy(id TEXT PRIMARY KEY, snapshot TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS session(id TEXT PRIMARY KEY, employee TEXT NOT NULL REFERENCES employee(id), evidence TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, epoch INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS note(id TEXT PRIMARY KEY, label TEXT NOT NULL, revision INTEGER NOT NULL);
 INSERT OR IGNORE INTO note VALUES('sample-1','Fictional note',1);
 INSERT OR IGNORE INTO note VALUES('sample-2','Other fictional note',1);
 CREATE TABLE IF NOT EXISTS approval(id TEXT PRIMARY KEY, actor TEXT NOT NULL, reviewer TEXT NOT NULL, digest TEXT NOT NULL, expires INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS receipt(key TEXT PRIMARY KEY, actor TEXT NOT NULL, digest TEXT NOT NULL, approval TEXT NOT NULL, resource TEXT NOT NULL, revision INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY, actor TEXT, operation TEXT NOT NULL, resource TEXT, outcome TEXT NOT NULL, epoch INTEGER NOT NULL, at INTEGER NOT NULL);`);
 const tokens=createScannerSessions({secret,ttlSeconds:900,now:clock});
 const epoch=()=>db.prepare('SELECT revision FROM epoch WHERE id=1').get().revision;
 const audit=(actor,operation,resource,outcome)=>db.prepare('INSERT INTO audit VALUES(?,?,?,?,?,?,?)').run(randomUUID(),actor,operation,resource,outcome,epoch(),clock());
 const transaction=fn=>{db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result}catch(e){db.exec('ROLLBACK');throw e}};
 const snapshot=(id,roles,individual=[])=>({tenant,environment,version:'v'+epoch(),roles,assignments:roles.map((r,i)=>({id:'a'+i,actorId:id,roleId:r.id,startsAt:0,expiresAt:8640000000000000,revoked:false})),individual});
 const rule=(id,operation,kind='grant',resource='sample-1')=>({id,kind,effect:effect(operation,resource),startsAt:0,expiresAt:8640000000000000,revoked:false});
 const role=(id,...rules)=>({id,active:true,rules});
 // No HTTP provisioning/login endpoints. Test operator invokes this explicitly in-process.
 const personas={'101':[role('owner',rule('o1',ops[0]),rule('o2',ops[2]))],
 '102':[role('manager',rule('m1',ops[0]),rule('m2',ops[1]),rule('m3',ops[2]))],
 '103':[role('employee',rule('e1',ops[0]))],
 '104':[role('reader',rule('r1',ops[0])),role('other',rule('r2',ops[0],'grant','sample-2'))],
 '105':[role('employee',rule('x1',ops[0]))],
 '106':[role('employee',rule('z1',ops[0]))],
 '107':[role('employee',rule('f1',ops[0]))],
 '108':[role('employee',rule('g1',ops[0]))]};
 function seed(){transaction(()=>{for(const [id,roles] of Object.entries(personas)){
 db.prepare('INSERT OR IGNORE INTO employee VALUES(?,?)').run(id,id==='106'?0:1);
 db.prepare('INSERT OR IGNORE INTO policy VALUES(?,?)').run(id,JSON.stringify(snapshot(id,roles,id==='105'?[{actorId:id,rule:rule('restrict',ops[0],'restrict')}]:[])));
 }})}
 function provision(id,{offsite=false,offsiteAllowed=false,expired=false}={}){
 return transaction(()=>{
 const p=db.prepare('SELECT active FROM employee WHERE id=?').get(id);if(p?.active!==1)throw fail();
 const token=tokens.issue({id}),b=tokens.verifyBound(token),now=clock(),end=expired?now:b.expiresAtMs;
 const live={active:true,revoked:false,startsAt:b.issuedAtMs,expiresAt:end},deviceId='d-'+id;
 const evidence={session:{...live,id:b.sessionId,actorId:id,tenant,deviceId,locked:false,method:offsite?'strong':'timeclock-pin',offsiteAllowed},
 device:{...live,id:deviceId,tenant,kind:'personal',actorId:id},site:offsite?null:{...live,id:'site-'+id,tenant,deviceId,sessionId:b.sessionId,verified:true,networkClass:'trusted-store'},
 strongProof:offsite?{...live,actorId:id,tenant,deviceId,sessionId:b.sessionId,verifiedAt:now}:null};
 db.prepare('INSERT INTO session VALUES(?,?,?,0,?)').run(b.sessionId,id,JSON.stringify(evidence),epoch());
 audit(id,'test.session.provision',null,'allowed');return {token,binding:b.sessionId};
 });
 }
 function authenticated(header){
 if(typeof header!=='string'||!header.startsWith('Bearer '))throw fail(401);
 let b;try{b=tokens.verifyBound(header.slice(7))}catch{throw fail(401)}
 const id=String(b.employeeId),p=db.prepare('SELECT active FROM employee WHERE id=?').get(id),s=db.prepare('SELECT * FROM session WHERE id=?').get(b.sessionId);
 if(p?.active!==1||!s||s.employee!==id||s.revoked!==0||s.epoch!==epoch())throw fail();
 const evidence=JSON.parse(s.evidence),policy=JSON.parse(db.prepare('SELECT snapshot FROM policy WHERE id=?').get(id).snapshot);
 // Every epoch invalidates existing sessions; new sessions see current persisted policy.
 policy.version='v'+epoch();
 return {id,binding:b.sessionId,epoch:epoch(),employee:{realm:'employee',id,tenant,active:true},evidence,policy};
 }
 function authorize(ctx,e,mode='business'){
 if(ctx.epoch!==epoch()||!evaluateSyntheticAssurance({actor:ctx.employee,...ctx.evidence,now:clock(),mode}).allowed||
 !evaluate({actor:ctx.employee,effect:e,snapshot:ctx.policy,now:clock()}).allowed)throw fail();
 }
 const command=(actor,resource,label,revision)=>({actor,tenant,environment,resource,label,revision,effects:[effect(ops[1],resource)]});
 function approve({actor,resource,label,revision,reviewer='101'}){
 // Test operator supplies immutable fictional approval only; no exposed approval issuance.
 if(actor===reviewer||!personas[actor]||reviewer!=='101'||!validKey(resource)||typeof label!=='string'||label.length>80||!Number.isSafeInteger(revision))throw fail();
 const id=randomUUID();transaction(()=>{db.prepare('INSERT INTO approval VALUES(?,?,?,?,?,0)').run(id,actor,reviewer,hash(command(actor,resource,label,revision)),clock()+60000);audit(reviewer,'test.approval.seed',resource,'allowed')});return id;
 }
 function request(header,method,path,body){
 let actor=null,operation='test.unknown',resource=null;
 try{return transaction(()=>{
 const ctx=authenticated(header);actor=ctx.id;
 const m=/^\/test\/notes\/(sample-[12])$/.exec(path),r=/^\/test\/receipts\/([A-Za-z0-9_-]{1,80})$/.exec(path);
 if(method==='GET'&&m){operation=ops[0];resource=m[1];authorize(ctx,effect(operation,resource));const row=db.prepare('SELECT label,revision FROM note WHERE id=?').get(resource);if(!row)throw fail();audit(actor,operation,resource,'allowed');return {status:200,data:row}}
 if(method==='GET'&&r){operation=ops[2];const receipt=db.prepare('SELECT * FROM receipt WHERE key=?').get(r[1]);if(!receipt||receipt.actor===actor)throw fail();resource=receipt.resource;authorize(ctx,effect(operation,resource));audit(actor,operation,resource,'allowed');return {status:200,data:{revision:receipt.revision,outcome:'committed',retryAllowed:false}}}
 if(method!=='POST'||!m)throw fail();
 operation=ops[1];resource=m[1];
 if(!exact(body,['label','expectedRevision','approvalRef','key'])||typeof body.label!=='string'||!body.label.trim()||body.label.length>80||!Number.isSafeInteger(body.expectedRevision)||!validKey(body.key)||!validKey(body.approvalRef))throw fail(400);
 const intent=command(actor,resource,body.label,body.expectedRevision),digest=hash(intent);
 authorize(ctx,effect(operation,resource));authorize(ctx,effect(ops[0],resource));
 const p=db.prepare('SELECT * FROM approval WHERE id=?').get(body.approvalRef);
 if(!p||p.actor!==actor||p.reviewer===actor||p.digest!==digest||p.revoked!==0||p.expires<=clock()||db.prepare('SELECT active FROM employee WHERE id=?').get(p.reviewer)?.active!==1)throw fail();
 const prior=db.prepare('SELECT * FROM receipt WHERE key=?').get(body.key);
 if(prior){if(prior.actor!==actor||prior.digest!==digest||prior.approval!==p.id)throw fail(409);audit(actor,operation,resource,'replayed');return {status:200,data:{revision:prior.revision,replayed:true}}}
 const row=db.prepare('SELECT revision FROM note WHERE id=?').get(resource);if(row?.revision!==body.expectedRevision)throw fail(409);
 authorize(ctx,effect(operation,resource));authorize(ctx,effect(ops[0],resource));
 if(p.expires<=clock())throw fail();
 db.prepare('UPDATE note SET label=?,revision=revision+1 WHERE id=?').run(body.label,resource);
 db.prepare('INSERT INTO receipt VALUES(?,?,?,?,?,?)').run(body.key,actor,digest,p.id,resource,row.revision+1);
 audit(actor,operation,resource,'committed');return {status:200,data:{revision:row.revision+1,replayed:false}};
 })}catch(e){try{transaction(()=>audit(actor,operation,resource,'denied'))}catch{}return {status:e.status||503,data:{error:'Request denied'}}}
 }
 const server=createServer(async(req,res)=>{
 res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json');res.setHeader('X-Content-Type-Options','nosniff');
 let result;try{let body=null;if(req.method==='POST'){let raw='';for await(const c of req){raw+=c;if(Buffer.byteLength(raw)>4096)throw fail(400)}body=JSON.parse(raw)}result=request(req.headers.authorization,req.method,req.url,body)}catch{result={status:400,data:{error:'Request denied'}}}
 res.writeHead(result.status);res.end(JSON.stringify(result.data));
 });
 return {seed,provision,approve,server,db,listen:()=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve('http://127.0.0.1:'+server.address().port))),
 revoke:binding=>transaction(()=>{db.prepare('UPDATE session SET revoked=1 WHERE id=?').run(binding);audit(null,'test.session.revoke',null,'allowed')}),
 advanceEpoch:()=>transaction(()=>{db.exec('UPDATE epoch SET revision=revision+1 WHERE id=1');audit(null,'test.policy.epoch',null,'allowed')}),
 close:async()=>{if(server.listening)await new Promise(resolve=>server.close(resolve));db.close()}};
}
