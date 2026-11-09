import {randomUUID} from 'node:crypto';

// UNMOUNTED FIRST OWNER COMMISSIONING CONSUMER. The first real Owner's
// authorization is issued OUTSIDE this application, by an independently
// verified and separately privileged operator. There is no create/approve
// endpoint here, and PIN/Discord/test-901 never authorize Owner access.
//
// Invoke commitRegistrationGrant only as the transaction callback of
// staffPasskeysPostgres.finishRegistration, after verified WebAuthn UV.
// This hook runs inside the SAME transaction as passkey insert/event.
const ID=/^[1-9][0-9]{0,17}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const denied=()=>Object.assign(new Error('Independent first Owner authorization required.'),{
  status:403,code:'HC_FIRST_OWNER_DENIED'
});
const unavailable=()=>Object.assign(new Error('Owner commissioning unavailable.'),{
  status:503,code:'HC_FIRST_OWNER_UNAVAILABLE'
});
export function createFirstOwnerCommissioning({
  verifySignedCanonicalEmployee,verifyIndependentEvidence,now=()=>Date.now()
}={}) {
  if([verifySignedCanonicalEmployee,verifyIndependentEvidence,now]
      .some(f=>typeof f!=='function'))
    throw new TypeError('Canonical Timeclock identity and independent offline evidence verifier required.');

  async function commitRegistrationGrant({context,employeeId,credentialId,client}={}) {
    const id=String(employeeId??''),t=now();
    if(!ID.test(id)||typeof credentialId!=='string'||credentialId.length<16||
       credentialId.length>1024||!Number.isSafeInteger(t)||t<0||
       typeof client?.query!=='function')throw denied();
    let identity;
    try{identity=await verifySignedCanonicalEmployee(context);}
    catch{throw denied();}
    if(identity?.active!==true||String(identity.id)!==id||
       String(identity.employeeId??identity.id)!==id||
       typeof identity.binding!=='string'||identity.binding.length<16||
       !Number.isSafeInteger(identity.expiresAtMs)||identity.expiresAtMs<=t)throw denied();

    // No existing Owner may be replaced or bypassed; UNIQUE index on the
    // admin principal table enforces this concurrently at insert time.
    // The provided client is already in the passkey transaction.
    let rows;
    try {
      rows=await client.query(
        `SELECT approval_id,employee_id,evidence_digest,independent_operator_ref,
          approved_at,expires_at,consumed_at,evidence_signature
         FROM hc_owner_commissioning_authorizations
         WHERE employee_id=$1 AND consumed_at IS NULL
         FOR UPDATE`,[id]);
    }catch{throw unavailable();}
    if(rows?.rowCount!==1||rows.rows?.length!==1)throw denied();
    const approval=rows.rows[0],approvedAt=new Date(approval.approved_at).getTime();
    const expiresAt=new Date(approval.expires_at).getTime();
    if(!UUID.test(String(approval.approval_id))||
       String(approval.employee_id)!==id||approval.consumed_at!==null||
       !Number.isFinite(approvedAt)||!Number.isFinite(expiresAt)||
       approvedAt>t||expiresAt<=t||expiresAt>approvedAt+30*60_000||
       !/^[a-f0-9]{64}$/.test(String(approval.evidence_digest))||
       typeof approval.independent_operator_ref!=='string'||
       approval.independent_operator_ref.length<8)throw denied();

    // Must validate the independently issued evidence again, and bind the
    // approval to the exact canonical employee and approved operator.
    // This callback must be backed by an independent identity authority.
    let verified=false;
    try{verified=await verifyIndependentEvidence({
      context,employeeId:id,approvalId:String(approval.approval_id),
      evidenceDigest:approval.evidence_digest,
      independentOperatorRef:approval.independent_operator_ref,
      approvedAt:new Date(approval.approved_at).toISOString(),
      expiresAt:new Date(approval.expires_at).toISOString(),
      evidenceSignature:approval.evidence_signature
    })===true;}catch{throw denied();}
    if(!verified)throw denied();

    try {
      const existing=await client.query(
        `SELECT employee_id FROM hc_admin_principals
         WHERE role='owner' AND active=true FOR UPDATE`);
      if(existing.rowCount!==0)throw denied();
      // No grant ahead of a successful registered passkey. A failure rolls
      // back BOTH passkey and role due to the calling transaction.
      const issued=await client.query(
        `UPDATE hc_owner_commissioning_authorizations
         SET consumed_at=now(),registered_credential_id=$2
         WHERE approval_id=$1 AND employee_id=$3 AND consumed_at IS NULL
           AND expires_at>now()
         RETURNING approval_id`,[approval.approval_id,credentialId,id]);
      if(issued.rowCount!==1)throw denied();
      await client.query(
        `INSERT INTO hc_admin_principals(employee_id,role,active,appointed_by)
         VALUES($1,'owner',true,NULL)`,[id]);
      await client.query(
        `INSERT INTO hc_owner_commissioning_events
          (event_id,approval_id,employee_id,credential_id,evidence_digest,event_type)
         VALUES($1,$2,$3,$4,$5,'first_owner_passkey_committed')`,
        [randomUUID(),approval.approval_id,id,credentialId,approval.evidence_digest]);
    }catch(error){
      if(error?.code==='HC_FIRST_OWNER_DENIED')throw error;
      throw unavailable();
    }
  }
  return Object.freeze({commitRegistrationGrant});
}
