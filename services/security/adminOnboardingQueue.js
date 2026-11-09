const id=/^[1-9][0-9]{0,17}$/;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const deny=()=>Object.assign(new Error('Employee onboarding permission denied.'),{status:403,code:'HC_ONBOARD_DENIED'});
const bad=()=>Object.assign(new Error('Invalid onboarding request.'),{status:400,code:'HC_ONBOARD_BAD_INPUT'});
const down=()=>Object.assign(new Error('Employee onboarding queue unavailable.'),{status:503,code:'HC_ONBOARD_UNAVAILABLE'});
const validName=name=>typeof name==='string' && name.length<=120 && /^[\p{L}\p{M}][\p{L}\p{M} .'-]{1,119}$/u.test(name.trim()) && name.trim().length>=2;
const statusResult=row=>Object.freeze({
 requestId:String(row.id),name:row.employee_name,
 requestedRole:row.requested_role,status:row.status,submittedBy:String(row.requested_by)
});
export function createAdminOnboardingQueue({pool,adminAccess,verifyOwner=null}={}){
 if(verifyOwner!==null&&typeof verifyOwner!=='function')throw new TypeError('Owner reviewer must be backend verified.');
 if(typeof pool?.connect!=='function'||typeof adminAccess?.authorize!=='function')
  throw new TypeError('Onboarding requires a verified administrator and private DB.');
 async function transaction(work){
  let db;
  try{
   db=await pool.connect();
   await db.query('BEGIN');
   const result=await work(db);
   await db.query('COMMIT');
   return result;
  }catch(error){
   if(db)await db.query('ROLLBACK').catch(()=>{});
   if(error?.code==='HC_ONBOARD_BAD_INPUT'||error?.code==='HC_ONBOARD_DENIED')throw error;
   throw down();
  }finally{db?.release();}
 }
 async function request({context,requestKey,name,requestedRole='staff',reason}={}){
  // Strong factor is required even for a minimal onboarding request.
  const actor=await adminAccess.authorize({
   context,operation:'employees.onboard',requireStrong:true
  });
  const employeeId=String(actor.employeeId);
  if(!id.test(employeeId)||!uuid.test(requestKey||'')||!validName(name)||
    !['staff','manager'].includes(requestedRole)||
    typeof reason!=='string'||reason.trim().length<8||reason.trim().length>400)throw bad();
  const cleanName=name.trim().replace(/\s+/g,' ');
  return transaction(async db=>{
   // Exactly-once request handling under retries.
   // Never silently reinterpret a request key with changed payload.
   const found=await db.query(
    'SELECT * FROM hc_admin_onboarding_requests WHERE request_key=$1 FOR UPDATE',[requestKey]);
   if(found.rowCount===1){
    const current=found.rows[0];
    if(String(current.requested_by)!==employeeId||current.employee_name!==cleanName||
       current.requested_role!==requestedRole||current.reason!==reason.trim())throw bad();
    return Object.freeze({...statusResult(current),replayed:true});
   }
   const inserted=await db.query(
    `INSERT INTO hc_admin_onboarding_requests
      (request_key,requested_by,employee_name,requested_role,reason)
     VALUES($1,$2,$3,$4,$5) ON CONFLICT (request_key) DO NOTHING RETURNING *`,
    [requestKey,employeeId,cleanName,requestedRole,reason.trim()]);
   if(inserted.rowCount!==1){
    // Another request with the same key may have committed while we waited
    // on the uniqueness constraint. Reconcile instead of reporting a
    // misleading failure or creating a second entry.
    const raced=await db.query('SELECT * FROM hc_admin_onboarding_requests WHERE request_key=$1',[requestKey]);
    const other=raced.rows?.[0];
    if(other && String(other.requested_by)===employeeId &&
       other.employee_name===cleanName && other.requested_role===requestedRole &&
       other.reason===reason.trim())return Object.freeze({...statusResult(other),replayed:true});
    throw bad();
   }
   const row=inserted.rows[0];
   await db.query(
    `INSERT INTO hc_admin_onboarding_events(request_id,actor_employee_id,action,reason)
      VALUES($1,$2,'requested',$3)`,
    [row.id,employeeId,reason.trim()]);
   return Object.freeze({...statusResult(row),replayed:false});
  });
 }
 async function ownRequests({context}={}){
  const actor=await adminAccess.authorize({context,operation:'employees.onboard'});
  if(!id.test(String(actor.employeeId)))throw deny();
  return transaction(async db=>{
   const rows=await db.query(
    `SELECT * FROM hc_admin_onboarding_requests
      WHERE requested_by=$1 ORDER BY created_at DESC LIMIT 50`,[actor.employeeId]);
   return Object.freeze({
    items:Object.freeze(rows.rows.map(statusResult)),ownOnly:true,readOnly:true
   });
  });
 }
 async function pendingReview({context}={}){
  if(typeof verifyOwner!=='function')throw deny();
  const actor=await adminAccess.authorize({
   context,operation:'employees.onboard.review',requireStrong:true
  });
  if(!(await verifyOwner(actor.employeeId)))throw deny();
  return transaction(async db=>{
   const result=await db.query(
    `SELECT * FROM hc_admin_onboarding_requests WHERE status='pending_review'
       ORDER BY created_at ASC LIMIT 100`);
   return Object.freeze({
    items:Object.freeze(result.rows.map(statusResult)),reviewOnly:true,readOnly:true
   });
  });
 }
 async function review({context,requestId,decision,reason}={}){
  if(typeof verifyOwner!=='function')throw deny();
  const actor=await adminAccess.authorize({
   context,operation:'employees.onboard.review',requireStrong:true
  });
  if(!(await verifyOwner(actor.employeeId)))throw deny();
  if(!uuid.test(requestId||'')||!['approve','reject'].includes(decision)||
     typeof reason!=='string'||reason.trim().length<8||reason.trim().length>400)throw bad();
  return transaction(async db=>{
   const result=await db.query(
    'SELECT * FROM hc_admin_onboarding_requests WHERE id=$1 FOR UPDATE',[requestId]);
   if(result.rowCount!==1)throw bad();
   const row=result.rows[0];
   if(row.status!=='pending_review')throw bad();
   const newStatus=decision==='approve'?'approved_pending_creation':'rejected';
   const updated=await db.query(
    'UPDATE hc_admin_onboarding_requests SET status=$1,updated_at=now() WHERE id=$2 RETURNING *',
    [newStatus,requestId]);
   await db.query(
    `INSERT INTO hc_admin_onboarding_events
      (request_id,actor_employee_id,action,reason) VALUES($1,$2,$3,$4)`,
    [requestId,actor.employeeId,decision==='approve'?'approved':'rejected',reason.trim()]);
   return Object.freeze({...statusResult(updated.rows[0]),accountCreated:false});
  });
 }
 // Onboarding requests DO NOT create Timeclock employee identities.
 // A separate future reviewed enrollment adapter is required for that.
 return Object.freeze({request,ownRequests,pendingReview,review});
}
