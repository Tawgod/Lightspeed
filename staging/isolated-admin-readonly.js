import {createEmployeeAdminAccess} from '../services/security/employeeAdminAccess.js';
import {createEmployeeAdminRouter} from '../routes/employeeAdmin.js';

// A read-only bridge for the existing isolated synthetic employee 901.
// Never treat the isolated Owner fixture as a real Timeclock Owner account.
// No admin grant tables, mutation adapters, or production staff are touched.
const ID='901';
const ORIGIN='https://staff-security-staging-test.up.railway.app';
const READ=new Set(['admin.read','tools.settings.read']);
const denied=()=>Object.assign(new Error('Isolated admin verification denied.'),{status:403});

export function createIsolatedAdminReadonlyMount({
 environment=process.env,gateway,passkeys,enrollment,now=()=>Date.now()
}={}){
 if(environment.NODE_ENV!=='test'||
    environment.HC_SECURITY_ENV!=='isolated-staging'||
    environment.HC_STAGING_ADMIN_READONLY_ENABLED!=='true'||
    environment.HC_STAGING_TEST_LOGIN_ENABLED!=='true'||
    environment.HC_STAGING_OWNER_PASSKEY_ENABLED!=='true'||
    environment.HC_STAGING_OWNER_ENROLLMENT_ENABLED!=='true'||
    environment.HC_STAGING_OWNER_BOOTSTRAP_ENABLED!=='false'||
    environment.HC_STAGING_PUBLIC_ORIGIN!==ORIGIN||
    typeof gateway?.verifyBoundEmployee!=='function'||
    typeof passkeys?.verifyStrongManager!=='function'||
    typeof enrollment?.verifyTotpStepUp!=='function'||
    typeof now!=='function')
  throw new TypeError('Isolated read-only administrator prerequisites not satisfied.');
 const fromTestSite=request=>{
  if(typeof request?.get!=='function')throw denied();
  const origin=request.get('origin');
  if(origin&&origin!==ORIGIN)throw denied();
  if(request.get('sec-fetch-site')==='cross-site')throw denied();
  return request;
 };
 const access=createEmployeeAdminAccess({
  now,
  verifyEmployeeSession:async req=>{
   fromTestSite(req);
   const employee=await gateway.verifyBoundEmployee(req);
   if(String(employee?.id)!==ID||
      employee?.active!==true||
      employee?.permissionSource&&employee.permissionSource!=='synthetic_staging_only')
     throw denied();
   return employee;
  },
  verifyPasskey:async req=>{
   fromTestSite(req);
   return passkeys.verifyStrongManager(req);
  },
  verifyTotp:async req=>{
   fromTestSite(req);
   return enrollment.verifyTotpStepUp(req);
  },
  canAdmin:async ({context,employeeId,operation})=>{
   fromTestSite(context);
   return employeeId===ID&&READ.has(operation);
  }
 });
 const router=createEmployeeAdminRouter({
  adminAccess:access,
  resolveCapabilities:async employeeId=>{
   if(employeeId!==ID)throw denied();
   return Object.freeze({
    employeeId:ID,role:'owner',
    operations:Object.freeze([...READ]),
    grantScopes:Object.freeze([])
   });
  }
 });
 return Object.freeze({router,adminAccess:access});
}
