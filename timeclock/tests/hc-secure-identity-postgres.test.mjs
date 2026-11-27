import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHcSecureIdentityProvider} from '../hcSecureIdentity.js';
const url=process.env.HC_SECURE_IDENTITY_TEST_DATABASE_URL;
test('disposable PG: exact BIGINT identity and independent pool reservations', {skip:!url}, async()=>{
  assert.equal(process.env.NODE_ENV,'test');assert.equal(process.env.HC_SECURE_IDENTITY_DISPOSABLE,'yes');
  const parsed=new URL(url);assert.equal(parsed.hostname,'127.0.0.1');assert.equal(parsed.pathname,'/hc_secure_identity_disposable');
  const {default:pg}=await import('pg');
  const a=new pg.Pool({connectionString:url,connectionTimeoutMillis:1000,statement_timeout:1000,lock_timeout:500});
  const b=new pg.Pool({connectionString:url,connectionTimeoutMillis:1000,statement_timeout:1000,lock_timeout:500});
  try {
    const db=await a.query('SELECT current_database() AS db');assert.equal(db.rows[0].db,'hc_secure_identity_disposable');
    const existing=await a.query("SELECT to_regclass('public.employees') AS employees,to_regnamespace('hc_security_identity') AS limiter");
    assert.equal(existing.rows[0].employees,null);assert.equal(existing.rows[0].limiter,null);
    await a.query('CREATE TABLE employees(id bigint PRIMARY KEY,active boolean NOT NULL,pin_hash text)');
    const id='9223372036854775807';await a.query('INSERT INTO employees VALUES($1,true,$2)',[id,'fixture:1234']);
    await a.query(await readFile(new URL('../db/hc_secure_identity_limits.sql',import.meta.url),'utf8'));
    const environment={HC_SECURE_IDENTITY_ENABLED:'true',HC_SECURE_IDENTITY_EMPLOYEE_ID:id,
      HC_SECURE_IDENTITY_SERVICE_SECRET:'a'.repeat(40),HC_SECURE_IDENTITY_THROTTLE_SECRET:'b'.repeat(40),HC_SECURE_IDENTITY_AUDIENCE:'fictional-test'};
    const make=pool=>createHcSecureIdentityProvider({pool,environment,pinHash:p=>`fixture:${p}`,verifyTransport:async()=>true});
    const x=make(a),y=make(b),request={operation:'verify-pin',body:{employeeId:id,pin:'1234'},
      credential:environment.HC_SECURE_IDENTITY_SERVICE_SECRET,audience:environment.HC_SECURE_IDENTITY_AUDIENCE,browserOrigin:false,transport:{fictional:true}};
    const results=await Promise.all(Array.from({length:8},(_,i)=>(i%2?x:y).handle(request)));
    assert.equal(results.filter(r=>r.status===200).length,5);
    assert.equal(results.filter(r=>r.status===403).length,3);
    for(const r of results.filter(r=>r.status===200))assert.deepEqual(r.body.employee,{id,active:true,employeeNumber:null});
    const auth={...request,operation:'authorize',body:{employeeId:id}};
    assert.equal((await y.handle(auth)).status,200);
    await a.query('UPDATE employees SET active=false WHERE id=$1',[id]);assert.equal((await x.handle(auth)).status,403);
    const count=await a.query('SELECT count(*)::int AS n FROM hc_security_identity.limits');assert.equal(count.rows[0].n,2);
  } finally {await a.end();await b.end();}
});
