import {findAdminSettingDescriptor} from './adminSettingsRegistry.js';
import {ADMIN_OPERATIONS,TOOL_OPERATIONS,isKnownPermission,isAdminPermission,
 isOwnerOnlyPermission} from './adminPermissionCatalog.js';

const denied=()=>Object.assign(new Error('Administrative permission denied.'),{status:403,code:'HC_DELEGATION_DENIED'});
const unavailable=()=>Object.assign(new Error('Administrative permissions unavailable.'),{status:503,code:'HC_DELEGATION_UNAVAILABLE'});
const ID=/^[1-9][0-9]{0,17}$/;
const allowedTools=new Set(TOOL_OPERATIONS);
const ROLES=new Set(['owner','delegated_admin']);
const reasonValid=reason=>typeof reason==='string'&&reason.trim().length>=8&&reason.trim().length<=400;
const employeeId=value=>ID.test(String(value||''))?String(value):null;
const readRole=async(db,id)=>{
 const result=await db.query('SELECT role,active,version FROM hc_admin_principals WHERE employee_id=$1',[id]);
 return result.rows?.[0]||null;
};
export function createAdminDelegations({pool,adminAccess=null,verifyTargetEmployee}={}){
 if(typeof pool?.connect!=='function'||typeof verifyTargetEmployee!=='function' ||
    (adminAccess!==null&&typeof adminAccess.authorize!=='function'))
  throw new TypeError('Durable admin permissions require PostgreSQL and verified manager access.');
 async function targetIsActive(targetEmployeeId){
  try{
   const candidate=await verifyTargetEmployee(targetEmployeeId);
   return candidate?.active===true &&
     String(candidate.id||candidate.employeeId)===targetEmployeeId;
  }catch{return false;}
 }
 async function transaction(work){
  let db;
  try{
   db=await pool.connect();await db.query('BEGIN');
   const result=await work(db);await db.query('COMMIT');return result;
  }catch(error){
   if(db)await db.query('ROLLBACK').catch(()=>{});
   if(error?.code==='HC_DELEGATION_DENIED')throw error;
   throw unavailable();
  }finally{db?.release();}
 }
 // Inject this callback into the employeeAdminAccess gate; never assume that
 // an enrolled factor or Timeclock's role implies administrative permission.
 async function canAdmin({employeeId:id,operation}={}){
  const employee=employeeId(id);
  if(!employee||typeof operation!=='string'||!isKnownPermission(operation))return false;
  try{return await transaction(async db=>{
   const role=await readRole(db,employee);
   if(!role||role.active!==true||!ROLES.has(role.role))return false;
   if(role.role==='owner')return true;
   if(isOwnerOnlyPermission(operation))return false;
   const result=await db.query(
    'SELECT 1 FROM hc_admin_grants WHERE employee_id=$1 AND operation=$2',
    [employee,operation]);
   // An admin must also possess an explicit entry grant. No implicit access
   // merely because someone granted an operation or a tool permission.
   const entry=await db.query(
    "SELECT 1 FROM hc_admin_grants WHERE employee_id=$1 AND operation='admin.read'",[employee]);
   return result.rowCount===1&&entry.rowCount===1;
  });}catch{return false;}
 }
 async function capabilitiesForVerifiedEmployee(employeeIdValue){
  const id=employeeId(employeeIdValue);
  if(!id)throw denied();
  return transaction(async db=>{
   const person=await readRole(db,id);
   if(!person||person.active!==true)throw denied();
   const granted=person.role==='owner'
    ?Object.keys(ADMIN_OPERATIONS)
    :(await db.query(
     'SELECT operation FROM hc_admin_grants WHERE employee_id=$1 ORDER BY operation',[id])).rows.map(x=>x.operation);
   if(!granted.includes('admin.read'))throw denied();
   const tools=person.role==='owner'
    ?TOOL_OPERATIONS
    :(await db.query(
     'SELECT tool_operation FROM hc_admin_grant_scopes WHERE employee_id=$1 ORDER BY tool_operation',[id])).rows.map(x=>x.tool_operation);
   return Object.freeze({
    employeeId:id,role:person.role,operations:Object.freeze(granted.filter(x=>isAdminPermission(x))),
    grantScopes:Object.freeze(tools.filter(x=>allowedTools.has(x)))
   });
  });
 }
 async function getRole({context}={}){
  if(!adminAccess)throw unavailable();
  const access=await adminAccess.authorize({context,operation:'admin.read'});
  return transaction(async db=>{
   const person=await readRole(db,access.employeeId);
   if(!person||person.active!==true)throw denied();
   return Object.freeze({employeeId:access.employeeId,role:person.role});
  });
 }
 async function listGrants({context,targetEmployeeId}={}){
  if(!adminAccess)throw unavailable();
  const access=await adminAccess.authorize({context,operation:'admin.delegation.manage',requireStrong:true});
  const id=employeeId(targetEmployeeId);
  if(!id)throw denied();
  return transaction(async db=>{
   const result=await db.query(
    'SELECT operation FROM hc_admin_grants WHERE employee_id=$1 ORDER BY operation',[id]);
   const scope=await db.query(
    'SELECT tool_operation FROM hc_admin_grant_scopes WHERE employee_id=$1 ORDER BY tool_operation',[id]);
   const settingScopes=await db.query(
    'SELECT setting_id FROM hc_admin_setting_scopes WHERE employee_id=$1 ORDER BY setting_id',[id]);
   const target=await readRole(db,id);
   return Object.freeze({
    employeeId:id,role:target?.role||null,active:target?.active===true,
    grants:result.rows.map(x=>x.operation),grantScopes:scope.rows.map(x=>x.tool_operation),
    settingScopes:settingScopes.rows.map(x=>x.setting_id)
   });
  });
 }
 // Admin access delegated per employee, only by the Owner (verified strong factor).
 async function changeAdminGrant({context,targetEmployeeId,operation,enabled,reason}={}){
  if(!adminAccess)throw unavailable();
  const actor=await adminAccess.authorize({context,operation:'admin.delegation.manage',requireStrong:true});
  const target=employeeId(targetEmployeeId);
  if(!target||target===actor.employeeId||!isAdminPermission(operation)||
     isOwnerOnlyPermission(operation)||typeof enabled!=='boolean'||!reasonValid(reason))throw denied();
  if(!(await targetIsActive(target)))throw denied();
  return transaction(async db=>{
   const issuer=await readRole(db,actor.employeeId);
   if(issuer?.role!=='owner'||issuer.active!==true)throw denied();
   const existing=await readRole(db,target);
   // No API can create/promote/demote an Owner. Owner commissioning is separate.
   if(existing?.role==='owner')throw denied();
   if(enabled){
    await db.query(
     `INSERT INTO hc_admin_principals(employee_id,role,appointed_by)
       VALUES($1,'delegated_admin',$2) ON CONFLICT(employee_id) DO NOTHING`,
     [target,actor.employeeId]);
    // Explicit reactivation requires independent employee lifecycle review.
    const current=await readRole(db,target);
    if(current?.active!==true||current.role!=='delegated_admin')throw denied();
    await db.query(
     'INSERT INTO hc_admin_grants(employee_id,operation,granted_by) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
     [target,operation,actor.employeeId]);
   }else{
    await db.query('DELETE FROM hc_admin_grants WHERE employee_id=$1 AND operation=$2',[target,operation]);
    if(operation==='admin.read'){
     // Stop leftover operation grants from implying access if entry is revoked.
     await db.query('DELETE FROM hc_admin_grants WHERE employee_id=$1',[target]);
     await db.query('DELETE FROM hc_admin_grant_scopes WHERE employee_id=$1',[target]);
     await db.query('DELETE FROM hc_admin_setting_scopes WHERE employee_id=$1',[target]);
    }
   }
   await db.query(
    `INSERT INTO hc_admin_authorization_events(actor_id,target_employee_id,kind,operation,reason)
     VALUES($1,$2,$3,$4,$5)`,
    [actor.employeeId,target,enabled?'admin_grant':'admin_revoke',operation,reason.trim()]);
   return Object.freeze({employeeId:target,operation,enabled});
  });
 }
 async function changeGrantScope({context,targetEmployeeId,toolOperation,enabled,reason}={}){
  if(!adminAccess)throw unavailable();
  const actor=await adminAccess.authorize({context,operation:'admin.delegation.manage',requireStrong:true});
  const target=employeeId(targetEmployeeId);
  if(!target||target===actor.employeeId||!allowedTools.has(toolOperation)||
    typeof enabled!=='boolean'||!reasonValid(reason))throw denied();
  if(!(await targetIsActive(target)))throw denied();
  return transaction(async db=>{
   const issuer=await readRole(db,actor.employeeId),manager=await readRole(db,target);
   if(issuer?.role!=='owner'||issuer.active!==true ||
      manager?.role!=='delegated_admin'||manager.active!==true)throw denied();
   if(enabled)await db.query(
    'INSERT INTO hc_admin_grant_scopes(employee_id,tool_operation,granted_by) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
    [target,toolOperation,actor.employeeId]);
   else await db.query('DELETE FROM hc_admin_grant_scopes WHERE employee_id=$1 AND tool_operation=$2',[target,toolOperation]);
   await db.query(
    `INSERT INTO hc_admin_authorization_events(actor_id,target_employee_id,kind,operation,reason)
      VALUES($1,$2,$3,$4,$5)`,
    [actor.employeeId,target,enabled?'scope_grant':'scope_revoke',toolOperation,reason.trim()]);
   return Object.freeze({employeeId:target,toolOperation,enabled});
  });
 }
 async function changeSettingScope({context,targetEmployeeId,settingId,enabled,reason}={}){
  if(!adminAccess)throw unavailable();
  const actor=await adminAccess.authorize({context,operation:'admin.delegation.manage',requireStrong:true});
  const target=employeeId(targetEmployeeId),setting=findAdminSettingDescriptor(settingId);
  if(!target||target===actor.employeeId||setting?.section!=='Tool Settings'||
    typeof enabled!=='boolean'||!reasonValid(reason))throw denied();
  if(!(await targetIsActive(target)))throw denied();
  return transaction(async db=>{
   const owner=await readRole(db,actor.employeeId),manager=await readRole(db,target);
   if(owner?.role!=='owner'||owner.active!==true||
     manager?.role!=='delegated_admin'||manager.active!==true)throw denied();
   if(enabled)await db.query(
    'INSERT INTO hc_admin_setting_scopes(employee_id,setting_id,granted_by) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
    [target,settingId,actor.employeeId]);
   else await db.query('DELETE FROM hc_admin_setting_scopes WHERE employee_id=$1 AND setting_id=$2',
    [target,settingId]);
   await db.query(
    `INSERT INTO hc_admin_authorization_events(actor_id,target_employee_id,kind,operation,reason)
     VALUES($1,$2,$3,$4,$5)`,
    [actor.employeeId,target,enabled?'setting_scope_grant':'setting_scope_revoke',settingId,reason.trim()]);
   return Object.freeze({employeeId:target,settingId,enabled});
  });
 }
 async function canManageSetting({employeeId:id,settingId}={}){
  const staff=employeeId(id),setting=findAdminSettingDescriptor(settingId);
  if(!staff||setting?.section!=='Tool Settings')return false;
  try{return await transaction(async db=>{
   const person=await readRole(db,staff);
   if(!person||person.active!==true)return false;
   if(person.role==='owner')return true;
   if(person.role!=='delegated_admin')return false;
   const access=await db.query(
    "SELECT operation FROM hc_admin_grants WHERE employee_id=$1 AND operation IN ('admin.read','tools.settings.manage')",
    [staff]);
   if(access.rowCount!==2)return false;
   const scope=await db.query(
    'SELECT 1 FROM hc_admin_setting_scopes WHERE employee_id=$1 AND setting_id=$2',[staff,settingId]);
   return scope.rowCount===1;
  });}catch{return false;}
 }
 // Source-only exact operation resolver for future tool gateway adapters.
 // A store device, employee PIN or UI role never authorizes an operation alone.
 async function canUseEmployeeTool({employeeId:subject,toolOperation}={}){
  const target=employeeId(subject);
  if(!target||!allowedTools.has(toolOperation)||!(await targetIsActive(target)))return false;
  try{return await transaction(async db=>{
   const result=await db.query(
    'SELECT 1 FROM hc_employee_tool_grants WHERE employee_id=$1 AND operation=$2',
    [target,toolOperation]);
   return result.rowCount===1;
  });}catch{return false;}
 }
 async function listEmployeeToolGrants({context,targetEmployeeId}={}){
  if(!adminAccess)throw unavailable();
  const actor=await adminAccess.authorize({context,operation:'permissions.read'});
  const target=employeeId(targetEmployeeId);
  if(!target||!(await targetIsActive(target)))throw denied();
  return transaction(async db=>{
   const issuer=await readRole(db,actor.employeeId);
   if(!issuer||issuer.active!==true)throw denied();
   const subject=await readRole(db,target);
   if(subject?.role==='owner'&&issuer.role!=='owner')throw denied();
   const results=await db.query(
    'SELECT operation FROM hc_employee_tool_grants WHERE employee_id=$1 ORDER BY operation',[target]);
   if(issuer.role==='owner'){
    return Object.freeze({employeeId:target,operations:Object.freeze(results.rows.map(x=>x.operation)),readOnly:true});
   }
   if(issuer.role!=='delegated_admin')throw denied();
   const scopes=await db.query(
    'SELECT tool_operation FROM hc_admin_grant_scopes WHERE employee_id=$1',[actor.employeeId]);
   const allowed=new Set(scopes.rows.map(x=>x.tool_operation));
   return Object.freeze({
    employeeId:target,
    operations:Object.freeze(results.rows.map(x=>x.operation).filter(op=>allowed.has(op))),
    scoped:true,readOnly:true
   });
  });
 }
 // A manager can grant ONLY the specific tool operations the Owner scoped.
 // Neither admin access nor private employee records can be granted through this route.
 async function changeEmployeeToolGrant({context,targetEmployeeId,toolOperation,enabled,reason}={}){
  if(!adminAccess)throw unavailable();
  const actor=await adminAccess.authorize({context,operation:'permissions.manage',requireStrong:true});
  const target=employeeId(targetEmployeeId);
  if(!target||target===actor.employeeId||!allowedTools.has(toolOperation)||
    typeof enabled!=='boolean'||!reasonValid(reason))throw denied();
  if(!(await targetIsActive(target)))throw denied();
  return transaction(async db=>{
   const manager=await readRole(db,actor.employeeId);
   if(!manager||manager.active!==true)throw denied();
   const subject=await readRole(db,target);
   if(subject?.role==='owner')throw denied();
   if(manager.role!=='owner'){
    if(manager.role!=='delegated_admin')throw denied();
    const scope=await db.query(
     'SELECT 1 FROM hc_admin_grant_scopes WHERE employee_id=$1 AND tool_operation=$2',
     [actor.employeeId,toolOperation]);
    if(scope.rowCount!==1)throw denied();
   }
   if(enabled)await db.query(
    'INSERT INTO hc_employee_tool_grants(employee_id,operation,granted_by) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
    [target,toolOperation,actor.employeeId]);
   else await db.query(
    'DELETE FROM hc_employee_tool_grants WHERE employee_id=$1 AND operation=$2',[target,toolOperation]);
   await db.query(
    `INSERT INTO hc_admin_authorization_events(actor_id,target_employee_id,kind,operation,reason)
     VALUES($1,$2,$3,$4,$5)`,
    [actor.employeeId,target,enabled?'tool_grant':'tool_revoke',toolOperation,reason.trim()]);
   return Object.freeze({employeeId:target,toolOperation,enabled});
  });
 }
 return Object.freeze({canAdmin,capabilitiesForVerifiedEmployee,getRole,listGrants,changeAdminGrant,changeGrantScope,changeSettingScope,canManageSetting,changeEmployeeToolGrant,canUseEmployeeTool,listEmployeeToolGrants});
}
