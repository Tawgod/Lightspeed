import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import pg from 'pg';
import {verifyOwnerStagingDatabasePrivileges} from '../services/security/ownerStagingDatabasePreflight.js';

// Only disposable GitHub Actions PostgreSQL. Never point at a live Railway DB.
const testUrl=process.env.HC_TEST_DATABASE_URL;
const sql=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
const fixturePaths=[
  'db/hc_admin_delegations.sql',
  'db/hc_staff_passkeys.sql',
  'db/hc_staff_auth_throttle.sql',
  'db/hc_staff_factor_approvals.sql',
  'db/hc_staff_totp.sql',
  'db/hc_first_owner_operator_activation.sql'
];

test('isolated staging database: runtime cannot issue/rewrite first Owner approval', {
  skip: !testUrl
},async()=>{
  const root=new pg.Client({connectionString:testUrl});
  await root.connect();
  const base=new URL(testUrl);
  const target=new URL(testUrl);
  target.pathname='/hc_owner_stage_test';
  const admin=new pg.Client({connectionString:target.toString()});
  let runtime,operator;
  try {
    assert.equal(base.hostname,'127.0.0.1','never operate against a non-local DB in tests');
    assert.equal(base.pathname,'/hc_test','tests require disposable hc_test database');
    await root.query('CREATE DATABASE hc_owner_stage_test');
    await admin.connect();
    for(const file of fixturePaths)await admin.query(sql(file));
    await admin.query(sql('db/hc_owner_staging_privilege_groups.sql'));
    await root.query("CREATE ROLE hc_owner_stage_ci_runtime LOGIN PASSWORD 'ci_fixture_only_runtime'");
    await root.query("CREATE ROLE hc_owner_stage_ci_operator LOGIN PASSWORD 'ci_fixture_only_operator'");
    await root.query('GRANT hc_owner_stage_runtime_privs TO hc_owner_stage_ci_runtime');
    await root.query('GRANT hc_owner_stage_operator_privs TO hc_owner_stage_ci_operator');
    await root.query('REVOKE CONNECT ON DATABASE hc_owner_stage_test FROM PUBLIC');
    await root.query('GRANT CONNECT ON DATABASE hc_owner_stage_test TO hc_owner_stage_ci_runtime,hc_owner_stage_ci_operator');
    const runtimeUrl=new URL(target.toString());
    runtimeUrl.username='hc_owner_stage_ci_runtime';
    runtimeUrl.password='ci_fixture_only_runtime';
    runtime=new pg.Pool({connectionString:runtimeUrl.toString()});
    assert.deepEqual(await verifyOwnerStagingDatabasePrivileges({pool:runtime}),{ready:true});
    const permissions=await runtime.query(
      \`SELECT has_table_privilege(current_user,'hc_first_owner_activations','INSERT') AS can_issue,
              has_table_privilege(current_user,'hc_first_owner_activations','DELETE') AS can_delete,
              has_column_privilege(current_user,'hc_first_owner_activations','activation_digest','UPDATE') AS can_rewrite,
              has_column_privilege(current_user,'hc_first_owner_activations','credential_id','UPDATE') AS can_consume\`
    );
    assert.deepEqual(permissions.rows[0],
      {can_issue:false,can_delete:false,can_rewrite:false,can_consume:true});
    const operatorUrl=new URL(target.toString());
    operatorUrl.username='hc_owner_stage_ci_operator';
    operatorUrl.password='ci_fixture_only_operator';
    operator=new pg.Pool({connectionString:operatorUrl.toString()});
    const op=await operator.query(
      \`SELECT has_table_privilege(current_user,'hc_first_owner_activations','INSERT') AS can_issue,
              has_table_privilege(current_user,'hc_staff_totp','SELECT') AS can_read_totp,
              has_column_privilege(current_user,'hc_first_owner_activations','credential_id','UPDATE') AS can_consume\`
    );
    assert.deepEqual(op.rows[0],
      {can_issue:true,can_read_totp:false,can_consume:false});
  }finally{
    if(runtime)await runtime.end();
    if(operator)await operator.end();
    await admin.end().catch(()=>{});
    await root.end();
  }
});
