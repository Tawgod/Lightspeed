// Read-only HC Secure credential commissioning preflight.
// Never connects to PostgreSQL, prints credentials, changes roles, issues Owner
// activations, or deploys. Secret values are accepted only in isolated offline
// operator environments and must never be copied from old Owner staging.
const PROJECT='120de974-f2e8-46be-9a00-8eb8b1be4cc4';
const ENVIRONMENT='8c8cd3a9-079f-4fe8-b8f5-a76c79813f0c';
const SERVICE='hc-secure-db-bootstrap-once';
const ROOT_HOST='hc-secure-postgres-staging.railway.internal';
const KEYS=Object.freeze([
 'HC_SECURE_DB_RUNTIME_PASSWORD','HC_SECURE_DB_OPERATOR_PASSWORD'
]);
const fail=()=>new Error('HC Secure credential commissioning preflight blocked.');
const strong=x=>typeof x==='string'&&/^[A-Za-z0-9]{48}$/.test(x);
export function verifyHcSecureCredentialCommissioningScope(e={}){
 if(e.RAILWAY_PROJECT_ID!==PROJECT||
    e.RAILWAY_ENVIRONMENT_ID!==ENVIRONMENT||
    e.RAILWAY_SERVICE_NAME!==SERVICE||
    e.HC_SECURE_CREDENTIAL_COMMISSION_ONLY!=='true'||
    e.HC_SECURE_DB_MUTATION_APPROVED!=='HC_SECURE_CREDENTIALS_ONLY'||
    e.HC_SECURE_DB_BOOTSTRAP_ONLY==='true'||
    e.HC_SECURE_ROLE_PREPARE_ONLY==='true'||
    e.HC_OWNER_STAGING_ENABLED==='true'||
    e.HC_OWNER_OPERATOR_ACK||
    ['DATABASE_URL','HC_OWNER_STAGING_DATABASE_URL',
      'HC_OWNER_OPERATOR_DATABASE_URL','HC_OWNER_TIMECLOCK_SERVICE_SECRET',
      'HC_OWNER_DB_RUNTIME_PASSWORD','HC_OWNER_DB_OPERATOR_PASSWORD',
      'LIGHTSPEED_TOKEN','DISCORD_TOKEN','TIMECLOCK_ADMIN_SECRET']
     .some(key=>String(e[key]??'').length>0))throw fail();
 let url;
 try{url=new URL(e.HC_SECURE_BOOTSTRAP_ROOT_URL);}catch{throw fail();}
 if(!['postgres:','postgresql:'].includes(url.protocol)||
    url.hostname!==ROOT_HOST||url.pathname!=='/railway'||
    url.username!=='postgres'||!strong(url.password)||
    url.search||url.hash)throw fail();
 const secrets=KEYS.map(key=>e[key]);
 if(secrets.some(v=>!strong(v))||new Set([...secrets,url.password]).size!==3)
  throw fail();
 return Object.freeze({
  ready:true,
  database:'hc_owner_stage_test',
  runtimeLogin:'hc_owner_stage_runtime',
  operatorLogin:'hc_owner_stage_operator',
  independentPasswords:true,
  // No secrets returned.
  requiresSeparatePasswordCommissioning:true
 });
}
