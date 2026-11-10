import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID,generateKeyPairSync,sign} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {createFirstOwnerPasskeyRegistrationCandidate}
  from '../services/security/firstOwnerPasskeyRegistrationCandidate.js';
import {ownerAttestationMessage} from '../services/security/firstOwnerAttestation.js';

const db=process.env.HC_TEST_DATABASE_URL;
const guarded={skip:!db?'Only disposable HC_TEST_DATABASE_URL may run commissioning DB tests':false};
const makeProvider=credentialId=>({
  generateRegistrationOptions:async()=>({challenge:randomBytes(32).toString('base64url')}),
  verifyRegistrationResponse:async()=>({
    verified:true,registrationInfo:{credential:{
      id:credentialId,publicKey:new Uint8Array(32),counter:0,transports:['internal']
    },credentialDeviceType:'multiDevice',credentialBackedUp:true}
  }),
  generateAuthenticationOptions:async()=>({challenge:'unused'}),
  verifyAuthenticationResponse:async()=>({verified:false})
});
test('first Owner signature, challenge, atomic credential+Owner+audit, no second Owner',guarded,async()=>{
  if(!/hc_test/.test(db))throw Error('Refusing non-disposable database');
  const adminPool=new pg.Pool({connectionString:db,max:2});
  const schema='hc_owner_candidate_'+process.pid;
  const {publicKey,privateKey}=generateKeyPairSync('ed25519');
  const operator='offline-operator-test-only';
  const publicKeyPem=publicKey.export({type:'spki',format:'pem'});
  const approvalId=randomUUID(),employeeId='42';
  const now=Date.now(),approvedAt=new Date(now-5000).toISOString();
  const expiresAt=new Date(now+120000).toISOString();
  const evidenceDigest='a'.repeat(64);
  const credentialId=randomBytes(32).toString('base64url');
  const evidenceSignature=sign(null,ownerAttestationMessage({
    approvalId,employeeId,evidenceDigest,independentOperatorRef:operator,
    approvedAt,expiresAt
  }),privateKey).toString('base64url');
  const context={session:'signed-real-timeclock'};
  let staffActive=true;
  let pool;
  try {
    await adminPool.query('CREATE SCHEMA '+schema);
    pool=new pg.Pool({connectionString:db,max:3,options:'-c search_path='+schema});
    for(const filename of ['hc_staff_passkeys.sql','hc_admin_delegations.sql','hc_owner_commissioning.sql']){
      await pool.query(await readFile(new URL('../db/'+filename,import.meta.url),'utf8'));
    }
    const base=()=>createFirstOwnerPasskeyRegistrationCandidate({
      environment:'test',enabled:true,pool,now:()=>Date.now(),
      origin:'http://localhost',rpID:'localhost',
      signingSecret:'test-only-first-owner-passkey-signing-key-123456',
      operatorPublicKeyPem:publicKeyPem,expectedOperatorRef:operator,
      loginThrottle:{reserve:async()=>true},
      staffAuthGateway:{verifyBoundEmployee:async request=>{
        if(request!==context||!staffActive)throw Error('No bound session');
        return {id:employeeId,employeeId,active:true,
          binding:'signed-canonical-owner-session-12345',expiresAtMs:Date.now()+60000};
      }},
      timeclockIdentity:{authorize:async id=>({
        id,permissionSource:'timeclock_employee',canLookup:true
      })},
      webauthn:makeProvider(credentialId)
    });
    const passkeys=base();
    await assert.rejects(passkeys.beginRegistration({context}),
      e=>e?.status===403,'No PIN-only first Owner');
    await pool.query(
      `INSERT INTO hc_owner_commissioning_authorizations
       (approval_id,employee_id,evidence_digest,evidence_signature,
        independent_operator_ref,approved_at,expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [approvalId,employeeId,evidenceDigest,evidenceSignature,operator,approvedAt,expiresAt]
    );
    // Force the final audit INSERT to fail. The existing passkey service
    // must roll back its credential and Owner role along with the approval.
    await pool.query(`CREATE FUNCTION fail_owner_audit() RETURNS trigger
      LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''CI audit failure''; END;'`);
    await pool.query(`CREATE TRIGGER owner_test_force_rollback
      BEFORE INSERT ON hc_owner_commissioning_events
      FOR EACH ROW EXECUTE FUNCTION fail_owner_audit()`);
    const attempt=await passkeys.beginRegistration({context});
    assert.equal(typeof attempt.challengeId,'string');
    await assert.rejects(passkeys.finishRegistration({
      context,challengeId:attempt.challengeId,response:{id:credentialId}
    }), e=>e?.status===503,'audit failure rolls back verified credential and Owner');
    const rolledBack=await Promise.all([
      pool.query('SELECT 1 FROM hc_staff_passkeys WHERE employee_id=$1',[employeeId]),
      pool.query('SELECT 1 FROM hc_admin_principals WHERE employee_id=$1',[employeeId]),
      pool.query('SELECT consumed_at FROM hc_owner_commissioning_authorizations WHERE approval_id=$1',[approvalId])
    ]);
    assert.equal(rolledBack[0].rowCount,0);
    assert.equal(rolledBack[1].rowCount,0);
    assert.equal(rolledBack[2].rows[0].consumed_at,null);
    await pool.query('DROP TRIGGER owner_test_force_rollback ON hc_owner_commissioning_events');
    await pool.query('DROP FUNCTION fail_owner_audit()');
    // A fresh challenge can now complete; the failed challenge was consumed
    // and cannot be replayed.
    await assert.rejects(passkeys.finishRegistration({
      context,challengeId:attempt.challengeId,response:{id:credentialId}
    }),e=>e?.status===403);
    const begin=await passkeys.beginRegistration({context});
    assert.equal(typeof begin.challengeId,'string');
    const finished=await passkeys.finishRegistration({
      context,challengeId:begin.challengeId,response:{id:credentialId}
    });
    assert.deepEqual(finished,{registered:true});
    const roles=await pool.query('SELECT role FROM hc_admin_principals WHERE employee_id=$1',[employeeId]);
    assert.equal(roles.rows[0].role,'owner');
    const passkeyRows=await pool.query('SELECT credential_id FROM hc_staff_passkeys WHERE employee_id=$1',[employeeId]);
    assert.equal(passkeyRows.rowCount,1);
    const audit=await pool.query('SELECT event_type FROM hc_owner_commissioning_events WHERE employee_id=$1',[employeeId]);
    assert.equal(audit.rows[0].event_type,'first_owner_passkey_committed');
    const consumed=await pool.query('SELECT consumed_at FROM hc_owner_commissioning_authorizations WHERE approval_id=$1',[approvalId]);
    assert.ok(consumed.rows[0].consumed_at);
    await assert.rejects(passkeys.beginRegistration({context}),
      e=>e?.status===403,'An active Owner forbids a second bootstrap');
    await assert.rejects(pool.query('DELETE FROM hc_owner_commissioning_events'),
      /append-only/);
    staffActive=false;
    await assert.rejects(passkeys.beginRegistration({context}),
      e=>e?.status===403);
  }finally{
    if(pool)await pool.end();
    await adminPool.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE').catch(()=>{});
    await adminPool.end();
  }
});
test('factory is explicitly off in production and does not expose identity issuance',()=>{
  assert.throws(()=>createFirstOwnerPasskeyRegistrationCandidate(),TypeError);
  assert.throws(()=>createFirstOwnerPasskeyRegistrationCandidate({
    environment:'production',enabled:true
  }),TypeError);
});
