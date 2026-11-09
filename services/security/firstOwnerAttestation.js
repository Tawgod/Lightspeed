import {createPublicKey,verify as verifySignature} from 'node:crypto';

// Public-key verification only. NO private operator key or authorization
// issuance exists in this application. A trusted, independently verified
// operator must sign the approved facts outside the employee PIN system.
// Application's public key is not evidence that a particular human is Owner.
const ID=/^[1-9][0-9]{0,17}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i;
const DIGEST=/^[a-f0-9]{64}$/;
const SIG=/^[A-Za-z0-9_-]{86}$/;

export function ownerAttestationMessage({
  approvalId,employeeId,evidenceDigest,independentOperatorRef,
  approvedAt,expiresAt
}={}) {
  if(!UUID.test(String(approvalId??''))||!ID.test(String(employeeId??''))||
     !DIGEST.test(String(evidenceDigest??''))||
     typeof independentOperatorRef!=='string'||
     independentOperatorRef.length<8||independentOperatorRef.length>128||
     /[^A-Za-z0-9_.:@-]/.test(independentOperatorRef))throw new TypeError('Invalid Owner attestation facts.');
  const start=Date.parse(approvedAt),end=Date.parse(expiresAt);
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||
     end>start+30*60_000||
     new Date(start).toISOString()!==approvedAt||
     new Date(end).toISOString()!==expiresAt)throw new TypeError('Invalid Owner attestation validity.');
  // Exact domain separation and stable canonical field order. Signs no
  // personal documents; only an irreversible digest and reference.
  return Buffer.from(JSON.stringify({
    domain:'hc:first-owner:commission:v1',
    approvalId:String(approvalId).toLowerCase(),
    employeeId:String(employeeId),
    evidenceDigest,
    independentOperatorRef,approvedAt,expiresAt
  }), 'utf8');
}

export function createIndependentOwnerAttestationVerifier({
  publicKeyPem,expectedOperatorRef,now=()=>Date.now()
}={}) {
  if(typeof publicKeyPem!=='string'||typeof expectedOperatorRef!=='string'||
     expectedOperatorRef.length<8||typeof now!=='function')
    throw new TypeError('Independently provisioned Ed25519 operator public key required.');
  let key;
  try {key=createPublicKey(publicKeyPem);}
  catch {throw new TypeError('Invalid Ed25519 operator public key.');}
  if(key.asymmetricKeyType!=='ed25519')throw new TypeError('Ed25519 operator public key required.');

  async function verifyIndependentEvidence({
    employeeId,approvalId,evidenceDigest,independentOperatorRef,
    approvedAt,expiresAt,evidenceSignature
  }={}) {
    if(independentOperatorRef!==expectedOperatorRef||
       typeof evidenceSignature!=='string'||!SIG.test(evidenceSignature))return false;
    const t=now();
    if(!Number.isSafeInteger(t)||t<0)return false;
    let message;
    try {
      message=ownerAttestationMessage({
        employeeId,approvalId,evidenceDigest,independentOperatorRef,
        approvedAt,expiresAt
      });
      if(Date.parse(approvedAt)>t||Date.parse(expiresAt)<=t)return false;
      const raw=Buffer.from(evidenceSignature,'base64url');
      return raw.length===64 && verifySignature(null,message,key,raw);
    } catch {return false;}
  }
  return Object.freeze({verifyIndependentEvidence});
}
