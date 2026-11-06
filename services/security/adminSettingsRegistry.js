// Central metadata registry for admin-visible Hobby Corner settings.
// Discovery only: entries cannot change production data by themselves.
// Writers must supply independent validators, permissions and audited mutations.
const definitions = [
  {id:'security.localSession',section:'Security',label:'Approved workstation session policy',source:'shared-security',owner:'Shared Lightspeed Services',status:'planned',kind:'session-policy',readOperation:'sessions.policy.read',writeOperation:'sessions.policy.manage'},
  {id:'security.remoteSession',section:'Security',label:'Remote session policy',source:'shared-security',owner:'Shared Lightspeed Services',status:'planned',kind:'session-policy',readOperation:'sessions.policy.read',writeOperation:'sessions.policy.manage'},
  {id:'security.factors',section:'Security',label:'Employee authenticators and recovery',source:'shared-security',owner:'Shared Lightspeed Services',status:'testing',kind:'employee-security',readOperation:'employees.security.read',writeOperation:'employees.security.manage'},
  {id:'security.workstations',section:'Security',label:'Trusted computers and setup download',source:'shared-security',owner:'Shared Lightspeed Services',status:'in-development',kind:'workstations',readOperation:'workstations.read',writeOperation:'workstations.manage'},
  {id:'employees.pin',section:'Employees',label:'Timeclock employee PIN management',source:'timeclock',owner:'Timeclock',status:'existing-api',kind:'employee',readOperation:'employees.read',writeOperation:'employees.pin.reset'},
  {id:'timeclock.schedules',section:'Timeclock',label:'Store hours and employee schedules',source:'timeclock',owner:'Timeclock',status:'existing-api',kind:'workforce',readOperation:'timeclock.read',writeOperation:'timeclock.manage'},
  {id:'timeclock.timeOff',section:'Timeclock',label:'PTO eligibility and time-off review',source:'timeclock',owner:'Timeclock',status:'existing-api',kind:'workforce',readOperation:'timeclock.read',writeOperation:'timeclock.manage'},
  {id:'timeclock.records',section:'Timeclock',label:'Time entries and audited corrections',source:'timeclock',owner:'Timeclock',status:'existing-api',kind:'workforce',readOperation:'timeclock.read',writeOperation:'timeclock.manage'},
  {id:'tools.permissions',section:'Tool Permissions',label:'Employee tool and operation grants',source:'shared-security',owner:'Shared Lightspeed Services',status:'planned',kind:'permissions',readOperation:'permissions.read',writeOperation:'permissions.manage'},
  {id:'scanner.review',section:'Tool Settings',label:'Product Scanner review and approval behavior',source:'scanner',owner:'Product Scanner',status:'requires-audit',kind:'tool',readOperation:'tools.settings.read',writeOperation:'tools.settings.manage'},
  {id:'productManager.defaults',section:'Tool Settings',label:'Product Manager creation and draft defaults',source:'product-manager',owner:'Product Manager',status:'planned',kind:'tool',readOperation:'tools.settings.read',writeOperation:'tools.settings.manage'},
  {id:'ordering.defaults',section:'Tool Settings',label:'Ordering and purchase-order workflow options',source:'ordering',owner:'Core Operations',status:'requires-audit',kind:'tool',readOperation:'tools.settings.read',writeOperation:'tools.settings.manage'},
  {id:'specialOrders.defaults',section:'Tool Settings',label:'Special Orders workflow options',source:'special-orders',owner:'Core Operations',status:'requires-audit',kind:'tool',readOperation:'tools.settings.read',writeOperation:'tools.settings.manage'},
  {id:'consignment.defaults',section:'Tool Settings',label:'Consignment workflow options',source:'consignment',owner:'Consignment Management',status:'planned',kind:'tool',readOperation:'tools.settings.read',writeOperation:'tools.settings.manage'}
];
const schema = /^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)+$/;
const op = /^[a-z][a-z.]+$/;
const states = new Set(['planned','in-development','testing','existing-api','requires-audit']);
function validate(value) {
  if (!value || !schema.test(value.id) || typeof value.section!=='string' ||
      value.section.length>64 || typeof value.label!=='string' ||
      value.label.length<4 || value.label.length>120 ||
      typeof value.source!=='string' || !/^[a-z-]{3,50}$/.test(value.source) ||
      typeof value.owner!=='string' || value.owner.length<3 || value.owner.length>70 ||
      typeof value.kind!=='string' || !/^[a-z-]{3,40}$/.test(value.kind) ||
      !states.has(value.status) || !op.test(value.readOperation) || !op.test(value.writeOperation))
    throw new TypeError('Invalid admin setting descriptor.');
}
const ids = new Set();
for (const value of definitions) {
  validate(value);
  if (ids.has(value.id)) throw new Error('Duplicate admin settings identifier.');
  ids.add(value.id);
  Object.freeze(value);
}
export const ADMIN_SETTINGS = Object.freeze(definitions);
export function listAdminSettingDescriptors({section}={}) {
  const filtered=section===undefined?ADMIN_SETTINGS:
    ADMIN_SETTINGS.filter(entry=>entry.section===section);
  return filtered.map(entry=>({...entry}));
}
export function findAdminSettingDescriptor(id) {
  return ADMIN_SETTINGS.find(entry=>entry.id===id) || null;
}
// Future extensions register a setting descriptor only through reviewed source;
// the client cannot POST a new descriptor, source or operation grant.
export function validateAdminSettingDescriptors(items) {
  if (!Array.isArray(items) || items.length>200) throw new TypeError('Invalid setting registry.');
  const seen=new Set();
  for (const item of items) {
    validate(item);
    if(seen.has(item.id)) throw new TypeError('Duplicate admin settings identifier.');
    seen.add(item.id);
  }
  return true;
}
