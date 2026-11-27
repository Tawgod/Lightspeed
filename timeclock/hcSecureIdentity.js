// Independent, server-only Timeclock identity provider. No route or grant is enabled here.
import {createHmac, timingSafeEqual} from 'node:crypto';

export function isCanonicalEmployeeId(value) {
  return typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) &&
    BigInt(value) <= 9223372036854775807n;
}
// Explicit enrollment scope only; never a roster, role, or permission grant.
function eligibleEmployees(environment) {
  const single=environment.HC_SECURE_IDENTITY_EMPLOYEE_ID;
  const multiple=environment.HC_SECURE_IDENTITY_EMPLOYEE_IDS;
  if (single!==undefined && multiple!==undefined) return null;
  let ids;
  try { ids=multiple===undefined?[single]:JSON.parse(multiple); } catch { return null; }
  if (!Array.isArray(ids) || ids.length===0 || ids.length>100 ||
      ids.some(id=>!isCanonicalEmployeeId(id)||id==='901') || new Set(ids).size!==ids.length) return null;
  return new Set(ids);
}
const key = value => typeof value === 'string' && Buffer.byteLength(value) >= 32;
const exact = (body, keys) => body && Object.getPrototypeOf(body) === Object.prototype &&
  Object.keys(body).length === keys.length && keys.every(k => Object.hasOwn(body, k));
const deny = () => ({status:403, body:{error:'Employee verification denied.'}});
const equal = (a,b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x=Buffer.from(a), y=Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x,y);
};

// Caller must provide an independently verified server transport adapter and a pool
// with reviewed connection/statement/lock limits. The provider bounds response waiting;
// an in-flight database statement may finish after denial. Never retry an unknown reservation.
export function createHcSecureIdentityProvider({pool, pinHash, verifyTransport, environment={}}={}) {
  const eligible=eligibleEmployees(environment);
  const secret=environment.HC_SECURE_IDENTITY_SERVICE_SECRET;
  const throttle=environment.HC_SECURE_IDENTITY_THROTTLE_SECRET;
  const audience=environment.HC_SECURE_IDENTITY_AUDIENCE;
  const legacy=['OWNER_STAGING_SERVICE_SECRET','OWNER_STAGING_THROTTLE_SECRET',
    'SCANNER_SERVICE_SECRET','TIMECLOCK_ADMIN_SECRET','TIMECLOCK_PIN_PEPPER'];
  const configured=environment.HC_SECURE_IDENTITY_ENABLED==='true' &&
    eligible!==null && key(secret) && key(throttle) &&
    secret!==throttle && legacy.every(k=>secret!==environment[k] && throttle!==environment[k]) &&
    typeof audience==='string' && /^[A-Za-z0-9_.:-]{1,150}$/.test(audience) &&
    typeof pool?.query==='function' && typeof pinHash==='function' && typeof verifyTransport==='function';
  const query=(text,values)=>pool.query({text,values,query_timeout:1000});
  async function execute(request,signal) {
    const {operation,body,credential,audience:actualAudience,transport,browserOrigin}=request;
    const verify=operation==='verify-pin';
    if (!configured || browserOrigin!==false || actualAudience!==audience || !equal(credential,secret) ||
        (!verify && operation!=='authorize') || !exact(body,verify?['employeeId','pin']:['employeeId']) ||
        !eligible.has(body.employeeId) || (verify && (typeof body.pin!=='string' || !/^\d{4}$/.test(body.pin)))) return deny();
    // Snapshot the selected request before any asynchronous operation.
    const id=body.employeeId;
    const pin=verify?body.pin:null;
    if (await verifyTransport({transport,audience,signal})!==true || signal.aborted) return deny();
    const limit=verify?5:120;
    const scope=createHmac('sha256',throttle).update(JSON.stringify(['hc-secure-identity-v1',operation,id])).digest('hex');
    const reserved=await query(`INSERT INTO hc_security_identity.limits(scope_key,count,window_start)
      VALUES($1,1,statement_timestamp()) ON CONFLICT(scope_key) DO UPDATE SET
      count=CASE WHEN hc_security_identity.limits.window_start<=statement_timestamp()-interval '15 minutes'
        THEN 1 ELSE LEAST(hc_security_identity.limits.count+1,$2::int+1) END,
      window_start=CASE WHEN hc_security_identity.limits.window_start<=statement_timestamp()-interval '15 minutes'
        THEN statement_timestamp() ELSE hc_security_identity.limits.window_start END
      RETURNING count<=$2::int AS admitted`,[scope,limit]);
    if (signal.aborted || reserved.rowCount!==1 || reserved.rows[0]?.admitted!==true) return deny();
    let hash;
    if (verify) { hash=pinHash(pin); if (typeof hash!=='string' || !hash) return deny(); }
    const found=await query('SELECT id::text AS id,active FROM employees WHERE id=$1::bigint AND active IS TRUE'+
      (verify?' AND pin_hash=$2':''),verify?[id,hash]:[id]);
    const row=found.rows[0];
    if (signal.aborted || found.rowCount!==1 || !exact(row,['id','active']) || row.id!==id || row.active!==true) return deny();
    return {status:200,body:{employee:{id,active:true,employeeNumber:null}}};
  }
  return Object.freeze({async handle(request) {
    if (!configured) return deny();
    const controller=new AbortController(); let timer;
    try {
      return await Promise.race([execute(request,controller.signal),new Promise(resolve=>{
        timer=setTimeout(()=>{controller.abort();resolve(deny());},3000);
      })]);
    } catch { return deny(); } finally {clearTimeout(timer);}
  }});
}
