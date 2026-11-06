// Server-only admin admission; an approved workstation alone is insufficient.
// Both employee identity and a current independent enrolled factor are mandatory.
const denied=()=>Object.assign(new Error('Independent administrator verification required.'),{status:403,code:'HC_ADMIN_DENIED'});
const unavailable=()=>Object.assign(new Error('Administrator authorization unavailable.'),{status:503,code:'HC_ADMIN_UNAVAILABLE'});
const STRONG=new Set(['passkey','security-key','oidc-mfa']);
const METHODS=new Set([...STRONG,'totp']);
const EMPLOYEE=/^[1-9][0-9]{0,17}$/;
const MAX_FACTOR_AGE_MS=5*60*1000;

export function createEmployeeAdminAccess({
  verifyEmployeeSession,verifyPasskey=null,verifyTotp=null,
  canAdmin,now=()=>Date.now()
}={}){
  if(typeof verifyEmployeeSession!=='function' ||
     typeof canAdmin!=='function' || typeof now!=='function' ||
     (verifyPasskey!==null&&typeof verifyPasskey!=='function') ||
     (verifyTotp!==null&&typeof verifyTotp!=='function') ||
     (!verifyPasskey&&!verifyTotp))
    throw new TypeError('Verified employee, independent admin factor and backend grants required.');

  async function authorize({context,operation='admin.read',requireStrong=false}={}){
    const instant=now();
    if(!context||!Number.isSafeInteger(instant)||instant<0)throw denied();
    let employee;
    try{employee=await verifyEmployeeSession(context);}
    catch{throw denied();}
    const id=String(employee?.employeeId||employee?.id||'');
    if(employee?.active!==true||!EMPLOYEE.test(id)||
       !Number.isSafeInteger(employee?.expiresAtMs)||employee.expiresAtMs<=instant ||
       typeof employee?.binding!=='string'||employee.binding.length<16)throw denied();
    let proof=null;
    if(verifyPasskey){
      try{proof=await verifyPasskey(context);}catch{ /* fail closed */ }
    }
    if((!proof||proof.verified!==true)&&!requireStrong&&verifyTotp){
      try{proof=await verifyTotp(context);}catch{ /* fail closed */ }
    }
    if(proof?.verified!==true || String(proof.employeeId)!==id ||
       !METHODS.has(proof.method) ||
       (requireStrong&&!STRONG.has(proof.method)) ||
       !Number.isSafeInteger(proof.authenticatedAtMs) ||
       proof.authenticatedAtMs>instant ||
       proof.authenticatedAtMs<=instant-MAX_FACTOR_AGE_MS)throw denied();

    // The registered employee's privilege is always checked server-side.
    let granted=false;
    try{granted=await canAdmin({
      context,employeeId:id,operation,method:proof.method
    })===true;}catch{throw unavailable();}
    if(!granted)throw denied();

    return Object.freeze({employeeId:id,method:proof.method,operation,verifiedAtMs:proof.authenticatedAtMs});
  }
  return Object.freeze({authorize});
}
