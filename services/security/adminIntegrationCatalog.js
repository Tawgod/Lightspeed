import {TOOL_OPERATIONS,ADMIN_OPERATIONS} from './adminPermissionCatalog.js';

// Source-owned cross-project integration inventory. This is NOT an
// entitlement list, runtime service discovery, or an assertion of deployment.
// The owning services must separately register tested, audited adapters.
const records=Object.freeze([
 {id:'special-orders',name:'Special Orders',navGroup:'special-orders',owner:'special-orders-test',state:'integration-pending',
  operations:['special-orders.read','special-orders.manage'],children:['preorders','ordering']},
 {id:'ordering',name:'Purchasing',navGroup:'special-orders',owner:'special-orders-test',state:'integration-pending',
  operations:['ordering.read','ordering.manage']},
 {id:'preorders',name:'Preorder Campaigns',navGroup:'special-orders',owner:'special-orders-test',state:'integration-pending',
  operations:['special-orders.read','special-orders.manage'],children:['gw-preorders']},
 {id:'gw-preorders',name:'GW Preorders',navGroup:'special-orders',owner:'special-orders-test',state:'integration-pending',
  operations:['special-orders.read','special-orders.manage']},
 {id:'scanner',name:'Product Scanner',navGroup:'store-tools',owner:'lightspeed-api',state:'integration-pending',
  operations:['scanner.lookup','scanner.stage','scanner.approve']},
 {id:'products',name:'Product Manager',navGroup:'store-tools',owner:'lightspeed-api',state:'integration-pending',
  operations:['products.read','products.draft','products.create','products.edit','products.archive']},
 {id:'purchase-orders',name:'PO Companion',navGroup:'store-tools',owner:'lightspeed-api',state:'integration-pending',
  operations:['purchase-orders.read','purchase-orders.draft','purchase-orders.write']},
 {id:'consignment',name:'Consignment',navGroup:'store-tools',owner:'consignment-beta',state:'beta-not-integrated',
  operations:['consignment.read','consignment.manage']},
 {id:'timeclock',name:'Timeclock',navGroup:'store-tools',owner:'timeclock',state:'integration-pending',
  operations:['timeclock.self.read','timeclock.self.clock']},
 {id:'employee-admin',name:'Employee Administration',navGroup:'admin',owner:'shared-staff-security',state:'staging-readonly',
  operations:Object.keys(ADMIN_OPERATIONS)}
]);
const allowed=new Set([...TOOL_OPERATIONS,...Object.keys(ADMIN_OPERATIONS)]);
const ids=new Set(records.map(x=>x.id));
if(ids.size!==records.length)throw Error('Duplicate integration ID');
for(const entry of records){
 if(entry.operations.some(op=>!allowed.has(op)))throw Error('Unknown integration operation');
 if(entry.children?.some(child=>!ids.has(child)))throw Error('Unknown nested navigation item');
}
export const ADMIN_INTEGRATION_NAVIGATION=Object.freeze({
 topLevel:Object.freeze(['special-orders','store-tools']),
 adminId:'employee-admin',
 adminRequires:'admin.read',
 rule:'Do not display admin navigation without server-confirmed admin.read. A link is not authorization.'
});
export function listAdminIntegrations({role,grantedOperations=[]}={}){
 if(!Array.isArray(grantedOperations))throw new TypeError('Verified operation list required');
 const owner=role==='owner';
 const grants=new Set(grantedOperations.filter(op=>allowed.has(op)));
 const admitted=owner||grants.has('admin.read');
 if(!admitted)return Object.freeze([]);
 return Object.freeze(records.map(item=>{
  const admin=item.id==='employee-admin';
  const operations=admin?item.operations.filter(op=>owner||grants.has(op)):item.operations;
  return Object.freeze({
   id:item.id,name:item.name,owner:item.owner,
   group:item.navGroup,state:item.state,
   children:Object.freeze([...(item.children||[])]),
   operations:Object.freeze([...operations]),
   permissionEnforcement:'not-integrated',
   settingsAdapter:'not-connected',
   requiresBackendAuthorization:true,
   showAdminLink:admin?admitted:false
  });
 }));
}
