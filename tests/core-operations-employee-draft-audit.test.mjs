import test from 'node:test';
import assert from 'node:assert/strict';
import {CORE_OPERATIONS_PROVISIONAL_SCOPES}
  from '../services/security/coreOperationsProvisionalScopes.js';
import {auditCoreOperationsEmployeeDraft}
  from '../services/security/coreOperationsEmployeeDraftAudit.js';

const draft=scope=>({
  source:scope.source,method:scope.method,path:scope.path,
  audience:'employee',operation:scope.operation,
  ...(scope.statusPolicy?{statusPolicy:scope.statusPolicy}:{}),
  ...(scope.bodyPolicy?{bodyPolicy:scope.bodyPolicy}:{}),
  ...(scope.queryPolicy?{queryPolicy:scope.queryPolicy}:{})
});
const all=()=>CORE_OPERATIONS_PROVISIONAL_SCOPES.map(draft);
const errorCodes=report=>report.issues.map(issue=>issue.code);

test('all 38 draft mappings are internally consistent but NONE is activated or owner-approved',()=>{
  const report=auditCoreOperationsEmployeeDraft({routes:all()});
  assert.equal(report.requestedRoutes,38);
  assert.equal(report.matchedCandidates,38);
  assert.equal(report.internallyConsistent,true);
  assert.equal(report.candidateOnly,true);
  assert.equal(report.requiresOwnerPolicyApproval,true);
  assert.equal(report.eligibleForActivation,false);
  assert.deepEqual(report.issues,[]);
  assert.equal(Object.isFrozen(report),true);
  assert.equal(Object.isFrozen(report.issues),true);
  assert.equal(Object.hasOwn(report,'approvedRoutes'),false);
  assert.equal(Object.hasOwn(report,'authorize'),false);
});

test('a write endpoint cannot be mislabeled as a routine read or broad legacy manage in the draft',()=>{
  const entries=all();
  const at=entries.findIndex(scope=>scope.method==='POST'&&scope.path==='/orders');
  assert.ok(at>=0);
  for(const operation of ['special-orders.read','ordering.read','special-orders.manage']){
    const invalid=entries.map((scope,index)=>index===at?{...scope,operation}:scope);
    const report=auditCoreOperationsEmployeeDraft({routes:invalid});
    assert.equal(report.internallyConsistent,false);
    assert.ok(errorCodes(report).includes('operation-mismatch'));
    assert.equal(report.eligibleForActivation,false);
  }
});

test('dynamic body and status policy annotations must be preserved exactly',()=>{
  for(const key of ['bodyPolicy','statusPolicy']){
    const entries=all();
    const at=entries.findIndex(scope=>scope[key]);
    assert.ok(at>=0);
    const missing=entries.map((scope,i)=>i===at?{...scope,[key]:undefined}:scope);
    const report=auditCoreOperationsEmployeeDraft({routes:missing});
    assert.equal(report.internallyConsistent,false);
    assert.ok(errorCodes(report).includes(key+'-mismatch'));
  }
});

test('unknown routes, service audiences, duplicates and unexpected configuration keys are blocked',()=>{
  const one=all()[0];
  for(const bad of [
    {...one,method:'GET',path:'/orders'},
    {...one,audience:'service'},
    {...one,approved:true},
    {...one,operation:'admin.delegation.manage'}
  ]){
    const report=auditCoreOperationsEmployeeDraft({routes:[bad]});
    assert.equal(report.internallyConsistent,false);
    assert.ok(report.issues.length>0);
    assert.equal(report.eligibleForActivation,false);
  }
  const duplicate=auditCoreOperationsEmployeeDraft({routes:[one,one]});
  assert.ok(errorCodes(duplicate).includes('duplicate-route'));
  assert.equal(duplicate.internallyConsistent,false);
});

test('missing, invalid and empty plans cannot be interpreted as approval',()=>{
  assert.throws(()=>auditCoreOperationsEmployeeDraft(),TypeError);
  assert.throws(()=>auditCoreOperationsEmployeeDraft({routes:{}}),TypeError);
  assert.throws(()=>auditCoreOperationsEmployeeDraft({routes:Array(129).fill({})}),TypeError);
  assert.equal(auditCoreOperationsEmployeeDraft({routes:[]}).internallyConsistent,false);
  assert.equal(auditCoreOperationsEmployeeDraft({routes:[]}).eligibleForActivation,false);
  assert.ok(errorCodes(auditCoreOperationsEmployeeDraft({routes:[null]})).includes('malformed-route'));
});
