import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';

test('activation issuer refuses automated/non-TTY invocation before any Timeclock or DB access',()=>{
 const script=new URL('../scripts/issue-owner-stage-activation.mjs',import.meta.url);
 const result=spawnSync(process.execPath,[script.pathname,'--issue-staging-owner'],{
  encoding:'utf8',timeout:10000,env:{
   ...process.env,NODE_ENV:'test',HC_SECURITY_ENV:'isolated-staging',
   HC_OWNER_STAGING_ENABLED:'true',
   HC_OWNER_TIMECLOCK_EMPLOYEE_ID:'42',
   HC_OWNER_OPERATOR_ACK:'I_VERIFIED_EMPLOYEE_ACCOUNT'
  }
 });
 assert.notEqual(result.status,0);
 assert.match(result.stderr,/Owner staging activation was NOT issued/);
 assert.doesNotMatch(result.stdout,/one-time staging activation/);
});
test('activation issuer retains no public web route, uses a fresh random digest and confirms a real canonical employee',async()=>{
 const script=await readFile(new URL('../scripts/issue-owner-stage-activation.mjs',import.meta.url),'utf8');
 assert.match(script,/process\.stdin\.isTTY/);
 assert.match(script,/process\.stdout\.isTTY/);
 assert.match(script,/random\(32\)/);
 assert.match(script,/createHash\('sha256'\)/);
 assert.match(script,/person\?\.permissionSource!=='timeclock_employee'/);
 assert.match(script,/agreed!==true/);
 assert.match(script,/pg_advisory_xact_lock/);
 assert.match(script,/previous\.rowCount!==0/);
 assert.match(script,/10\*60_000/);
 assert.doesNotMatch(script,/router\.(get|post|use)\(/);
});
