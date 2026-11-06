// Backend-only owner commissioning: NEVER expose as a browser or public API.
// A separately reviewed deployment maps the real Owner's Timeclock employee ID
// before calling this function. PIN, Discord, browser role and the first
// visitor are never a source of Owner authority.
const denied=()=>Object.assign(new Error('Owner commissioning denied.'),{status:403,code:'HC_OWNER_COMMISSION_DENIED'});
const unavailable=()=>Object.assign(new Error('Owner commissioning unavailable.'),{status:503,code:'HC_OWNER_COMMISSION_UNAVAILABLE'});
const ID=/^[1-9][0-9]{0,17}$/;
export function createAdminOwnerCommissioning({
 pool,expectedOwnerEmployeeId,verifyEmployee,verifyOwnerPasskey,now=()=>Date.now()
}={}){
 if(typeof pool?.connect!=='function'||!ID.test(String(expectedOwnerEmployeeId||''))||
    typeof verifyEmployee!=='function'||typeof verifyOwnerPasskey!=='function'||typeof now!=='function')
  throw new TypeError('Explicit Owner Timeclock identity and strong verified commissioning required.');
 const ownerId=String(expectedOwnerEmployeeId);
 async function commission({context}={}){
  if(!context)throw denied();
  const instant=now();
  if(!Number.isSafeInteger(instant)||instant<0)throw denied();
  let employee,proof;
  try{
   employee=await verifyEmployee(context);
   proof=await verifyOwnerPasskey(context);
  }catch{throw denied();}
  const empId=String(employee?.employeeId||employee?.id||'');
  if(employee?.active!==true||empId!==ownerId||
     proof?.verified!==true||String(proof.employeeId)!==ownerId||
     !['passkey','security-key'].includes(proof.method)||
     proof.purpose!=='owner.commission'||
     !Number.isSafeInteger(proof.authenticatedAtMs)||
     proof.authenticatedAtMs>instant||proof.authenticatedAtMs<=instant-300000)
   throw denied();
  let db;
  try{
   db=await pool.connect();
   await db.query('BEGIN');
   // Serialize the one-time ceremony across simultaneous app replicas.
   await db.query('SELECT pg_advisory_xact_lock(78619136,801)');
   const count=await db.query("SELECT employee_id FROM hc_admin_principals WHERE role='owner'");
   if(count.rowCount!==0)throw denied();
   await db.query(
    "INSERT INTO hc_admin_principals(employee_id,role,active) VALUES($1,'owner',true)",
    [ownerId]);
   await db.query('COMMIT');
   return Object.freeze({commissioned:true,employeeId:ownerId,role:'owner'});
  }catch(error){
   if(db)await db.query('ROLLBACK').catch(()=>{});
   if(error?.code==='HC_OWNER_COMMISSION_DENIED')throw error;
   throw unavailable();
  }finally{db?.release();}
 }
 return Object.freeze({commission});
}
