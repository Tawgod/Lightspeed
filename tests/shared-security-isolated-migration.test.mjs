import test from 'node:test';
import assert from 'node:assert/strict';
import {assertIsolatedTestDatabase,migrateIsolatedTestLogin} from '../staging/migrate-isolated-test-login.js';

const env={
 NODE_ENV:'test',HC_SECURITY_ENV:'isolated-staging',
 HC_STAGING_TEST_OWNER_DISCORD_ID:'115626919134887940',
 HC_STAGING_TEST_GUILD_ID:'1485804234753573066',
 DATABASE_URL:'postgresql://staging_user:staging_pass@Postgres.railway.internal:5432/railway'
};
test('migration refuses prod markers, public databases and malformed URLs',()=>{
 for(const changed of [
  {NODE_ENV:'production'},
  {HC_SECURITY_ENV:'production'},
  {HC_STAGING_TEST_GUILD_ID:'2485804234753573066'},
  {HC_STAGING_TEST_OWNER_DISCORD_ID:'215626919134887940'},
  {DATABASE_URL:'postgresql://u:p@lightspeed-prod.railway.app:5432/production'},
  {DATABASE_URL:'postgresql://u:p@127.0.0.1:5432/test'},
  {DATABASE_URL:'postgresql://u:p@other.internal:5432/test'},
  {DATABASE_URL:'postgresql://u:p@postgres.railway.internal:5432/db?sslmode=disable'},
  {DATABASE_URL:'postgresql://u:p@postgres.railway.internal:5432/'},
  {DATABASE_URL:''}
 ]) assert.throws(()=>assertIsolatedTestDatabase({...env,...changed}));
 assert.equal(assertIsolatedTestDatabase(env).hostname,'Postgres.railway.internal');
});
test('isolated migration applies known throttle schema in transaction; commits once',async()=>{
 const calls=[],client={
  query:async q=>{calls.push(q);return {rows:[]}},
  end:async()=>{calls.push('END')}
 };
 await migrateIsolatedTestLogin({
  environment:env,connect:async()=>client,
  loadSchema:async()=> 'CREATE TABLE IF NOT EXISTS hc_staff_auth_throttle (key_hash TEXT)'
 });
 assert.deepEqual(calls,['BEGIN','CREATE TABLE IF NOT EXISTS hc_staff_auth_throttle (key_hash TEXT)','COMMIT','END']);
});
test('isolated migration rolls back errors and releases the connection',async()=>{
 const calls=[],client={
  query:async q=>{calls.push(q);if(q.startsWith('CREATE'))throw Error('db unavailable')},
  end:async()=>{calls.push('END')}
 };
 await assert.rejects(migrateIsolatedTestLogin({
  environment:env,connect:async()=>client,
  loadSchema:async()=> 'CREATE TABLE IF NOT EXISTS hc_staff_auth_throttle (key_hash TEXT)'
 }),/db unavailable/);
 assert.deepEqual(calls,['BEGIN','CREATE TABLE IF NOT EXISTS hc_staff_auth_throttle (key_hash TEXT)','ROLLBACK','END']);
});
