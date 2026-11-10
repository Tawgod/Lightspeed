import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import {createOwnerStageLimiter} from '../ownerStagingIdentity.js';

const url=process.env.OWNER_STAGE_TEST_DATABASE_URL;
test('durable Owner stage rate limit survives separate pool instances', {skip:!url},async()=>{
  const a=new pg.Pool({connectionString:url});
  const b=new pg.Pool({connectionString:url});
  try {
    await a.query(readFileSync(new URL('../db/hc_owner_stage_login_limits.sql',import.meta.url),'utf8'));
    await a.query('TRUNCATE hc_owner_stage_login_limits');
    const secret='dedicated-durable-limiter-test-key-00001';
    const reserveA=createOwnerStageLimiter({pool:a,secret});
    const reserveB=createOwnerStageLimiter({pool:b,secret});
    const input={employeeId:'42',sourceIp:'127.0.0.1',action:'pin'};
    const attempts=await Promise.all(Array.from({length:6},(_,i)=>
      (i%2 ? reserveB : reserveA)(input)));
    assert.equal(attempts.filter(Boolean).length,5);
    assert.equal(attempts.filter(value=>!value).length,1);
    assert.equal(await reserveA(input),false);
    assert.equal(await reserveB({...input,action:'authorize'}),true);
    const rows=await a.query('SELECT count(*)::int AS n FROM hc_owner_stage_login_limits');
    assert.equal(rows.rows[0].n,2);
  } finally {
    await a.end();
    await b.end();
  }
});
