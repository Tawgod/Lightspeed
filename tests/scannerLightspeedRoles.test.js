import test from 'node:test';
import assert from 'node:assert/strict';
import {linkedScannerApproval,scannerRoleFromLightspeedUser} from '../timeclock/scannerLightspeedRoles.js';

const staff=[
  {id:'111',name:'Manager',role:'manager',active:true},
  {id:'222',name:'Admin',role:{name:'Admin'}},
  {id:'333',name:'Cashier',role_name:'Cashier'},
  {id:'444',name:'Inactive Manager',role:'manager',active:false},
  {id:'555',name:'Custom',role:{id:42,name:'Store Specialist'}},
];
test('automatically grants manager/admin and account owner only on exact supported role names',()=>{
 for(const id of ['111','222']){const a=linkedScannerApproval({lightspeedUserId:id,users:staff});assert.equal(a.verified,true);assert.equal(a.canApprove,true);}
 assert.equal(scannerRoleFromLightspeedUser({role:'Account Owner'}).canApprove,true);
});
test('does not elevate cashiers, unrecognized roles or inactive managers',()=>{
 for(const id of ['333','444','555'])assert.equal(linkedScannerApproval({lightspeedUserId:id,users:staff}).canApprove,false);
 assert.equal(scannerRoleFromLightspeedUser({role_id:1}).canApprove,false);
 assert.equal(scannerRoleFromLightspeedUser({role:'Super Manager'}).canApprove,false);
});
test('never uses employee name and fails closed for unmapped or duplicate IDs',()=>{
 assert.equal(linkedScannerApproval({lightspeedUserId:'999',users:staff}).canApprove,false);
 assert.equal(linkedScannerApproval({lightspeedUserId:'111',users:[...staff,{id:'111',role:'admin'}]}).canApprove,false);
 assert.equal(linkedScannerApproval({lightspeedUserId:'',users:staff}).canApprove,false);
 assert.equal(linkedScannerApproval({lightspeedUserId:'111',users:null}).canApprove,false);
 assert.equal(linkedScannerApproval({lightspeedUserId:'111',users:[{name:'Manager',role:'admin'}]}).canApprove,false);
});
test('ignores role hints outside supported role-name properties',()=>{
 assert.equal(scannerRoleFromLightspeedUser({permissions:['all'],role_id:1}).canApprove,false);
 assert.equal(scannerRoleFromLightspeedUser({role:'manager',status:'disabled'}).canApprove,false);
});
