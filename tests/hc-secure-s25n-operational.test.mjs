import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {readFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {createOperationalRead} from '../services/security/operationalRead.js';
import {verifyOperationalPrivileges} from '../services/security/operationalPrivileges.js';
import {withAuthorityFence} from '../services/security/authorityFence.js';
test('operational schema, real signed sessions, scoped projection and privilege denial (isolated upstream adapters)',async()=>{
 assert.equal(process.env.NODE_ENV,'test');assert.equal(process.env.HC_S25M_DISPOSABLE,'yes');
 const config={host:'127.0.0.1',port:5432,database:'hc_s25m_disposable'};
 const admin=new pg.Pool({...config,user:'postgres',password:'disposable-only'});
 const pool=new pg.Pool({...config,user:'hc_s25n_runtime',password:'disposable-n-only'});
 const secret=randomBytes(48).toString('hex');let now=Date.now(),active=true,restricted=false,sourceBad=false;
 const q={version:'HC-SECURE-READ/0.1',requestId:'r1',operation:'catalog.read',tenant:'fictional',environment:'test',audience:'catalog',location:'outlet-001',resourceType:'product',resourceId:'000701',variantId:null,sourceRevision:'r1',sourceRef:'example',fields:['productId','variantId','name'],purpose:'lookup'};
 const person=()=>({id:'101',active,employeeNumber:'0001'});
 const opts={pool,runtimeRole:'hc_s25n_runtime',secret,tenant:q.tenant,environment:q.environment,audience:q.audience,operation:q.operation,clock:()=>now,identity:{verifyPin:async(id,pin)=>id==='101'&&pin==='1234'?person():null,authorize:async()=>person()},throttle:{reserve:async()=>true},verifyAssurance:async()=>({deviceId:'test-device',siteId:'test-site',method:'timeclock-pin',expiresAt:now+3600000}),admitSource:async scope=>({status:'observed',complete:!sourceBad,scope,data:{productId:'000701',variantId:null,name:'Fictional model kit'}}),evaluatePolicy:async({effect,stage})=>effect.resourceId==='000701'&&effect.variantId===null&&!(restricted&&stage==='projection'&&effect.fields[0]==='name')};
 // Explicitly isolated simulated identity, throttle, assurance, policy and source.
 // Cryptographic session signing, PostgreSQL persistence, fence and grants are real.
 try{
 const check=await admin.query('SELECT current_database() db,host(inet_server_addr()) addr');assert.equal(check.rows[0].db,config.database);assert.match(check.rows[0].addr,/^(127\.0\.0\.1|172\.(1[6-9]|2[0-9]|3[01])\.[0-9]{1,3}\.[0-9]{1,3})$/);
 await admin.query(await readFile(new URL('../db/hc_security_operational.sql',import.meta.url),'utf8'));
 await admin.query("CREATE ROLE hc_s25n_runtime LOGIN PASSWORD 'disposable-n-only'; GRANT USAGE ON SCHEMA hc_security_operational TO hc_s25n_runtime; GRANT SELECT ON hc_security_operational.authority,hc_security_operational.employee,hc_security_operational.session TO hc_s25n_runtime; GRANT INSERT ON hc_security_operational.session,hc_security_operational.audit TO hc_s25n_runtime; GRANT UPDATE(revoked) ON hc_security_operational.session TO hc_s25n_runtime; INSERT INTO hc_security_operational.employee VALUES('101',true,'{}')");
 await verifyOperationalPrivileges({pool,runtimeRole:opts.runtimeRole});
 await assert.rejects(verifyOperationalPrivileges({pool:admin,runtimeRole:'postgres'}));
 for(const sql of ["UPDATE hc_security_operational.authority SET policy_revision=99","UPDATE hc_security_operational.employee SET active=true","UPDATE hc_security_operational.session SET expires_at=99","DELETE FROM hc_security_operational.audit","SELECT * FROM hc_security_operational.audit","CREATE TABLE hc_security_operational.forbidden(id int)"])await assert.rejects(pool.query(sql));
 const disabled=await createOperationalRead(opts);await assert.rejects(disabled.issue({employeeId:'101',pin:'1234',sourceIp:'127.0.0.1'}));
 const service=await createOperationalRead({...opts,enabled:true});
 const issue=()=>service.issue({employeeId:'101',pin:'1234',sourceIp:'127.0.0.1'});
 await assert.rejects(service.issue({employeeId:'101',pin:'9999',sourceIp:'127.0.0.1'}));
 const first=await issue();await assert.rejects(service.context(first.token+'x',{}));
 const h=await service.context(first.token,{});
 assert.equal((await service.read({},q)).status,'denied');
 assert.deepEqual((await service.read(h,q)).data,{productId:'000701',variantId:null,name:'Fictional model kit'});
 for(const change of [{audience:'wrong'},{fields:['name']},{variantId:'wrong'},{resourceId:'wrong'}])assert.equal((await service.read(h,{...q,...change})).data,null);
 restricted=true;assert.equal((await service.read(h,q)).status,'denied');restricted=false;
 sourceBad=true;assert.equal((await service.read(h,q)).status,'unavailable');sourceBad=false;
 active=false;assert.equal((await service.read(h,q)).status,'denied');active=true;
 await service.logout(h);await assert.rejects(service.context(first.token,{}));
 const second=await issue(),h2=await service.context(second.token,{});
 await withAuthorityFence(admin,c=>c.query('UPDATE hc_security_operational.authority SET evidence_revision=evidence_revision+1'));
 assert.equal((await service.read(h2,q)).data,null);
 const third=await issue();now+=901000;await assert.rejects(service.context(third.token,{}));
 const counts=await admin.query("SELECT count(*)::int n FROM hc_security_operational.audit WHERE outcome='read'");assert.equal(counts.rows[0].n,1);
 }finally{await pool.end();await admin.end()}
});
