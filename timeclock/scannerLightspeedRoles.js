// Derive scanner approval eligibility from the linked Lightspeed X-Series user.
// No name matching, browser-provided role, or API-token permissions are trusted.
export function scannerRoleFromLightspeedUser(user){
  if(!user || typeof user!=='object' || Array.isArray(user)) return {role:null,canApprove:false,verified:false};
  // Accept only explicit role names. Numeric IDs and custom role names require a
  // separately verified roles/permission mapping; never infer from an ID.
  const candidate=user.role_name ?? user.roleName ??
    (typeof user.role==='string'?user.role:user.role?.name) ??
    (typeof user.user_role==='string'?user.user_role:user.user_role?.name);
  const role=typeof candidate==='string'?candidate.trim().toLowerCase():null;
  const normalized=role?.replace(/[\s_-]+/g,' ')||null;
  const named=normalized==='admin' || normalized==='administrator' || normalized==='manager' ||
    normalized==='account owner' || normalized==='owner';
  const cashier=normalized==='cashier';
  // Reject an explicitly deactivated user even if their stored role is elevated.
  const active=user.active!==false && user.is_active!==false &&
    !['inactive','disabled','deleted','archived'].includes(String(user.status||'').toLowerCase());
  return {role:normalized,canApprove:Boolean(named&&active),verified:Boolean((named||cashier)&&active)};
}
export function linkedScannerApproval({lightspeedUserId,users}={}){
  const id=String(lightspeedUserId||'').trim();
  if(!id||!Array.isArray(users))return {role:null,canApprove:false,verified:false,reason:'unlinked'};
  const matches=users.filter(user=>String(user?.id??user?.user_id??user?.userId??'').trim()===id);
  if(matches.length!==1)return {role:null,canApprove:false,verified:false,reason:'missing_or_duplicate'};
  return {...scannerRoleFromLightspeedUser(matches[0]),reason:'matched_id'};
}
