import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {ownerAttestationMessage,createIndependentOwnerAttestationVerifier} from '../services/security/firstOwnerAttestation.js';

const NOW=Date.parse('2026-11-09T23:00:00Z');
const keys=generateKeyPairSync('ed25519');
const other=generateKeyPairSync('ed25519');
const publicKeyPem=keys.publicKey.export({type:'spki',format:'pem'});
const facts={
 approvalId:'01234567-89ab-4cde-8fab-0123456789ab',
 employeeId:'42',evidenceDigest:'a'.repeat(64),
 independentOperatorRef:'independent-business-verifier-01',
 approvedAt:new Date(NOW-1000).toISOString(),
 expiresAt:new Date(NOW+60000).toISOString()
};
const signed=(values=facts,key=keys.privateKey)=>({
 ...values,evidenceSignature:sign(null,ownerAttestationMessage(values),key).toString('base64url')
});
const verifier=()=>createIndependentOwnerAttestationVerifier({
 publicKeyPem,expectedOperatorRef:facts.independentOperatorRef,now:()=>NOW
});
test('only matching independent Ed25519 signature on canonical approval facts is accepted',async()=>{
 assert.equal(await verifier().verifyIndependentEvidence(signed()),true);
});
test('signature cannot be relabeled to another employee, approval, operator or expiration',async()=>{
 const signature=signed().evidenceSignature;
 for(const change of [
  {employeeId:'901'},{approvalId:'11111111-1111-4111-8111-111111111111'},
  {evidenceDigest:'b'.repeat(64)},
  {independentOperatorRef:'other-approved-operator'},
  {expiresAt:new Date(NOW+120000).toISOString()}
 ]){
  assert.equal(await verifier().verifyIndependentEvidence({
   ...facts,...change,evidenceSignature:signature
  }),false);
 }
});
test('rejects offline approval signed by the wrong operator key',async()=>{
 assert.equal(await verifier().verifyIndependentEvidence(signed(facts,other.privateKey)),false);
});
test('rejects expired or future-issued signed approvals and invalid signatures',async()=>{
 const expired={...facts,approvedAt:new Date(NOW-120000).toISOString(),expiresAt:new Date(NOW-60000).toISOString()};
 const future={...facts,approvedAt:new Date(NOW+60000).toISOString(),expiresAt:new Date(NOW+120000).toISOString()};
 assert.equal(await verifier().verifyIndependentEvidence(signed(expired)),false);
 assert.equal(await verifier().verifyIndependentEvidence(signed(future)),false);
 assert.equal(await verifier().verifyIndependentEvidence({...facts,evidenceSignature:'x'}),false);
});
test('construction requires approved Ed25519 public key and exact operator binding',()=>{
 assert.throws(()=>createIndependentOwnerAttestationVerifier(),TypeError);
 const rsa=generateKeyPairSync('rsa',{modulusLength:2048}).publicKey.export({type:'spki',format:'pem'});
 assert.throws(()=>createIndependentOwnerAttestationVerifier({
  publicKeyPem:rsa,expectedOperatorRef:facts.independentOperatorRef
 }),TypeError);
 assert.throws(()=>ownerAttestationMessage({...facts,approvedAt:'Monday'}),TypeError);
});
