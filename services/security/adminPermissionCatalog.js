// Explicit server-enforced admin permissions. No implicit role inheritance for
// delegated managers; only a verified Owner may delegate administrative grants.
export const ADMIN_OPERATIONS=Object.freeze({
 'admin.read':{label:'Open administration',level:'entry'},
 'employees.onboard':{label:'Request new employee onboarding',level:'delegable'},
 'employees.onboard.review':{label:'Review employee onboarding requests',level:'owner-only'},
 'employees.directory.read':{label:'View minimum employee directory',level:'delegable'},
 'employees.private.read':{label:'View private employee information',level:'sensitive'},
 'employees.pin.reset':{label:'Assign/reset employee PIN',level:'sensitive'},
 'employees.security.manage':{label:'Manage employee factors and recovery',level:'sensitive'},
 'timeclock.read':{label:'View Timeclock records',level:'sensitive'},
 'timeclock.manage':{label:'Change Timeclock records',level:'sensitive'},
 'tools.settings.read':{label:'List tool settings',level:'delegable'},
 'tools.settings.manage':{label:'Change approved tool settings',level:'delegable'},
 'permissions.read':{label:'View effective tool permissions',level:'delegable'},
 'permissions.manage':{label:'Grant employee tool permissions',level:'delegable'},
 'admin.delegation.manage':{label:'Grant/revoke admin access and delegations',level:'owner-only'},
 'sessions.policy.read':{label:'Review session policy',level:'delegable'},
 'sessions.policy.manage':{label:'Change login windows',level:'owner-only'},
 'workstations.read':{label:'List approved computers',level:'delegable'},
 'workstations.manage':{label:'Register/revoke approved computers',level:'owner-only'},
 'audit.read':{label:'Review administrative changes',level:'sensitive'}
});
export const TOOL_OPERATIONS=Object.freeze([
 'products.read','products.draft','products.create','products.edit','products.archive',
 'scanner.lookup','scanner.stage','scanner.approve',
 'purchase-orders.read','purchase-orders.draft','purchase-orders.write',
 'inventory.read','inventory.adjust','sales.read','sales.write',
 'store-credit.read','store-credit.write',
 'special-orders.read','special-orders.manage',
 // Proposed exact Core Operations scopes: available to the security policy
 // for staging tests, but NO staff grants, UI options or route allowlist are
 // activated by their mere presence. Owner review remains required.
 'special-orders.purchase-metrics.refresh',
 'special-orders.notes.write','special-orders.routing.write',
 'special-orders.status.progress','special-orders.status.write',
 'special-orders.create','special-orders.delete',
 'special-orders.notifications.send',
 'preorders.allocate','preorders.publish',
 'ordering.read','ordering.manage',
 'ordering.draft.write','ordering.receive','ordering.vendor.push',
 'ordering.suppliers.sync','ordering.context.refresh',
 'customers.lightspeed.create',
 'consignment.read','consignment.manage',
 'timeclock.self.read','timeclock.self.clock'
]);
const known=new Set([...Object.keys(ADMIN_OPERATIONS),...TOOL_OPERATIONS]);
const ownerOnly=new Set(Object.entries(ADMIN_OPERATIONS).filter(([,x])=>x.level==='owner-only').map(([k])=>k));
const prohibitedManagerDelegations=new Set([
 'employees.private.read','employees.pin.reset','employees.security.manage',
 'timeclock.read','timeclock.manage','audit.read',
 'admin.delegation.manage','sessions.policy.manage','workstations.manage'
]);
export function isKnownPermission(operation){return typeof operation==='string'&&known.has(operation)}
export function isAdminPermission(operation){return Object.hasOwn(ADMIN_OPERATIONS,operation)}
export function isOwnerOnlyPermission(operation){return ownerOnly.has(operation)}
export function isRestrictedDelegation(operation){return prohibitedManagerDelegations.has(operation)}
export function visibleAdminSections(grants,role){
 const has=op=>role==='owner'||grants.includes(op);
 return Object.freeze({
  employees:has('employees.onboard')||has('employees.directory.read')||has('employees.private.read'),
  employeePrivate:has('employees.private.read'),
  timeclock:has('timeclock.read')||has('timeclock.manage'),
  settings:has('tools.settings.read')||has('tools.settings.manage'),
  permissions:has('permissions.read')||has('permissions.manage'),
  security:role==='owner'||has('employees.security.manage')||has('sessions.policy.read'),
  devices:role==='owner'||has('workstations.read'),
  audit:has('audit.read')
 });
}
