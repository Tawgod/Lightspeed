import {createPostgresStaffPasskeys} from './staffPasskeysPostgres.js';
import {createFirstOwnerCommissioning} from './firstOwnerCommissioning.js';
import {createIndependentOwnerAttestationVerifier} from './firstOwnerAttestation.js';
import {createCanonicalStaffFactorSession} from './primaryLiveTotpEnrollmentGate.js';

// UNMOUNTED integration candidate. Only independently provisioned PUBLIC KEY.
// The app cannot create its one-use approval. Test mode prevents production use.
const denied=()=>Object.assign(new Error('Independent first Owner approval required.'),{
  status:403,code:'HC_FIRST_OWNER_REGISTRATION_DENIED'
});
export function createFirstOwnerPasskeyRegistrationCandidate({
  environment,enabled=false,staffAuthGateway,timeclockIdentity,
  pool,operatorPublicKeyPem,expectedOperatorRef,
  origin,rpID,signingSecret,loginThrottle,now=()=>Date.now(),
  webauthn,createPasskeys=createPostgresStaffPasskeys
}={}) {
  if(environment!=='test'||enabled!==true||
      typeof pool?.connect!=='function'||typeof now!=='function'||
      typeof createPasskeys!=='function')
    throw new TypeError('Disabled first Owner candidate requires explicit isolated test mode.');
  const canonical=createCanonicalStaffFactorSession({
    staffAuthGateway,timeclockIdentity,now
  });
  const verifier=createIndependentOwnerAttestationVerifier({
    publicKeyPem:operatorPublicKeyPem,expectedOperatorRef,now
  });
  const commissioning=createFirstOwnerCommissioning({
    verifySignedCanonicalEmployee:canonical.verifyBoundEmployee,
    verifyIndependentEvidence:verifier.verifyIndependentEvidence,
    now
  });
  // This is ONLY an eligibility check before issuing a challenge. Approval
  // is revalidated AFTER WebAuthn user verification inside the transaction.
  async function authorizeRegistration({context,employeeId,phase}={}) {
    if(!['begin','complete'].includes(phase))return false;
    let identity;
    try{identity=await canonical.verifyBoundEmployee(context);}catch{return false;}
    if(identity.id!==String(employeeId))return false;
    let client;
    try {
      client=await pool.connect();
      const existing=await client.query(
        "SELECT 1 FROM hc_admin_principals WHERE role='owner' AND active=true LIMIT 1"
      );
      if(existing.rowCount!==0)return false;
      const approvals=await client.query(
        `SELECT approval_id,employee_id,evidence_digest,evidence_signature,
                independent_operator_ref,approved_at,expires_at
         FROM hc_owner_commissioning_authorizations
         WHERE employee_id=$1 AND consumed_at IS NULL
           AND approved_at<=now() AND expires_at>now()
         LIMIT 2`,[identity.id]
      );
      if(approvals.rowCount!==1)return false;
      const a=approvals.rows[0];
      if(String(a.employee_id)!==identity.id)return false;
      return await verifier.verifyIndependentEvidence({
        employeeId:identity.id,approvalId:String(a.approval_id),
        evidenceDigest:a.evidence_digest,
        independentOperatorRef:a.independent_operator_ref,
        approvedAt:new Date(a.approved_at).toISOString(),
        expiresAt:new Date(a.expires_at).toISOString(),
        evidenceSignature:a.evidence_signature
      });
    }catch{return false;}finally{client?.release();}
  }
  const passkeys=createPasskeys({
    pool,origin,rpID,signingSecret,loginThrottle,now,
    verifyBoundEmployee:canonical.verifyBoundEmployee,
    authorizeRegistration,
    // PIN, forged headers and staging roles may never manage credentials.
    verifyStrongManager:async()=>{throw denied();},
    canManage:async()=>false,
    commitRegistrationGrant:commissioning.commitRegistrationGrant,
    ...(webauthn?{webauthn}:{})
  });
  if(typeof passkeys?.beginRegistration!=='function'||
     typeof passkeys?.finishRegistration!=='function')
    throw new TypeError('Verified passkey transaction required.');
  return Object.freeze({beginRegistration:passkeys.beginRegistration,
    finishRegistration:passkeys.finishRegistration});
}
