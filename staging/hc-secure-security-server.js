import {hcSecureStagingGate} from '../services/security/hcSecureStagingGate.js';
import {startOwnerStaging} from './owner-security-server.js';

// New HC Secure replacement only. No bootstrap, migration, or activation
// issuance. The existing Owner runtime verifies detailed DB privileges and
// identity secrets after the isolated environment gate passes.
export async function startHcSecureStaging(environment=process.env){
 const result=hcSecureStagingGate(environment);
 if(!result.ready)throw new Error('HC Secure staging gate blocked');
 return startOwnerStaging(environment);
}
if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href){
 startHcSecureStaging().catch(()=>{
  // Never expose configuration, URLs, credentials, schema or SQL in logs.
  console.error('HC Secure staging startup blocked; no listener started.');
  process.exitCode=1;
 });
}
