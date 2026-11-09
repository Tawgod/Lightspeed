import express from 'express';

// The navigation hint is deliberately weaker than administrator access:
// it verifies a signed, active employee session and exact admin.read grant,
// while the Admin destination still requires an independent TOTP/passkey.
// This endpoint neither grants permissions nor creates an Owner.
const ID=/^[1-9][0-9]{0,17}$/;
const deny=(res)=>res.status(403).json({allowed:false,authenticated:false,operation:'admin.read'});
export function createAdminNavigationAccessRouter({verifyEmployee,hasAdminRead}={}){
 if(typeof verifyEmployee!=='function'||typeof hasAdminRead!=='function')
  throw new TypeError('Signed staff session and exact backend admin.read authorization required.');
 const router=express.Router();
 router.use((_req,res,next)=>{
  res.set({'Cache-Control':'no-store, max-age=0','Pragma':'no-cache','Vary':'Authorization'});
  next();
 });
 router.get('/navigation-access',async(req,res)=>{
  const authorization=req.get('authorization')||'';
  if(!/^Bearer [A-Za-z0-9._~-]+$/.test(authorization))return deny(res);
  let employee;
  try{employee=await verifyEmployee(req);}
  catch{return deny(res);}
  const id=String(employee?.id??employee?.employeeId??'');
  if(!ID.test(id)||String(employee.id??employee.employeeId)!==id ||
     employee?.active===false||employee?.permissionSource==='synthetic_staging_only')
   return deny(res);
  // Only exact authorization from the durable grant store is accepted;
  // Timeclock/scanner roles, names and client-supplied headers are ignored.
  let granted=false;
  try{granted=(await hasAdminRead({employeeId:id,operation:'admin.read'}))===true;}
  catch{return deny(res);}
  if(!granted)return deny(res);
  return res.json({allowed:true,authenticated:true,operation:'admin.read'});
 });
 return router;
}

// Read-only adapter for the admin schema, which is separately provisioned.
// Admin read must be an explicit manager grant or an independently
// commissioned Owner principal. An unprovisioned DB/table fails closed.
// No schema migrations or role creation are performed here.
export function createAdminNavigationGrantReader({pool}={}){
 if(typeof pool?.query!=='function')throw new TypeError('Explicit admin grant database pool required.');
 return async ({employeeId,operation})=>{
  if(!ID.test(String(employeeId||''))||operation!=='admin.read')return false;
  try{
   const result=await pool.query(
    `SELECT 1 FROM hc_admin_principals p
       WHERE p.employee_id=$1 AND p.active=TRUE
       AND (p.role='owner'
         OR (p.role='delegated_admin'
           AND EXISTS(SELECT 1 FROM hc_admin_grants g
                      WHERE g.employee_id=p.employee_id AND g.operation='admin.read')))
       LIMIT 1`,
    [String(employeeId)]
   );
   return result.rowCount===1;
  }catch{return false;}
 };
}
