import { randomUUID } from 'node:crypto';
import { fingerprintLightspeedPayload as fp } from './idempotency.js';
const fail=(code,outcome='not_committed')=>Object.assign(Error('M7 fixture operation cannot proceed safely.'),{code,outcome});
const snap=v=>{fp(v);return JSON.parse(JSON.stringify(v));};
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
const id=v=>typeof v==='string'&&v.length>0&&v.length<=512&&!/[\x00-\x1f]/.test(v);
const type=v=>typeof v==='string'&&/^[a-z][a-z0-9_.-]{0,95}$/.test(v);
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(key=>Object.hasOwn(v,key));
const targetKey=t=>JSON.stringify([t.type,t.id]);
const ordered=(a,b)=>a<b?-1:a>b?1:0;
export function normalizeLocalEffectsM7(effects,targets){
  if(!Array.isArray(effects)||!effects.length)throw TypeError('Exact effects required');
  const normalized=effects.map(e=>{
    if(!exact(e,['operation','target','location','fields'])||!type(e.operation)||!exact(e.target,['type','id'])||!targets.some(t=>targetKey(t)===targetKey(e.target))||!id(e.location)||!Array.isArray(e.fields)||!e.fields.length||e.fields.some(f=>!type(f))||new Set(e.fields).size!==e.fields.length)throw TypeError('Invalid effect scope');
    return {...e,fields:[...e.fields].sort()};
  }).sort((a,b)=>ordered(fp(a),fp(b)));
  if(new Set(normalized.map(fp)).size!==normalized.length)throw TypeError('Duplicate effects');
  return normalized;
}

// Test-only opt-in. No registry, session or policy implementation.
export function prepareExecutionM7({tenant,scope,key,actor,targets,effects,payload,expectedRevisions}={}){
  if(!id(tenant)||!type(scope)||!scope.startsWith('test.')||!id(key)||key.length<8)throw TypeError('Invalid M7 execution');
  const a=snap(actor);
  if(!exact(a,['type','id','realm','tenant','delegation'])||a.tenant!==tenant||!id(a.id)||!['employee','service'].includes(a.type)||a.realm!==a.type||!exact(a.delegation,['kind'])||a.delegation.kind!=='none'||a.type!=='employee')throw TypeError('Unsupported actor or delegation');
  const ts=snap(targets);
  if(!Array.isArray(ts)||!ts.length||ts.some(t=>!exact(t,['type','id'])||!type(t.type)||!id(t.id))||new Set(ts.map(targetKey)).size!==ts.length)throw TypeError('Invalid targets');
  ts.sort((a,b)=>ordered(targetKey(a),targetKey(b)));
  const es=normalizeLocalEffectsM7(snap(effects),ts);
  const revisions=snap(expectedRevisions);
  if(!Array.isArray(revisions)||revisions.length!==ts.length||revisions.some(r=>!exact(r,['target','revision'])||!exact(r.target,['type','id'])||!ts.some(t=>targetKey(t)===targetKey(r.target))||!(r.revision===null||Number.isSafeInteger(r.revision)&&r.revision>0))||new Set(revisions.map(r=>targetKey(r.target))).size!==ts.length)throw TypeError('Exact revisions required');
  revisions.sort((a,b)=>ordered(targetKey(a.target),targetKey(b.target)));
  return freeze({version:'core.execution.v7',tenant,environment:'test',scope,key,actor:a,targets:ts,effects:es,expectedRevisions:revisions,payload:snap(payload)});
}
export function createLocalTransactionM7({tenant,transaction,authorizeExecution,verifyApproval,authorizeAccess,auditDenied,inspectCommitted,receiptSchema,projectResult}={}){
  if(!id(tenant)||![transaction,authorizeExecution,verifyApproval,authorizeAccess,auditDenied,inspectCommitted,projectResult].every(f=>typeof f==='function'))throw TypeError('Explicit synthetic adapters required');
  const schema=freeze(snap(receiptSchema));
  if(!exact(schema,['version','fields'])||!type(schema.version)||!Array.isArray(schema.fields)||!schema.fields.length||new Set(schema.fields).size!==schema.fields.length||schema.fields.some(f=>typeof f!=='string'||!/^(?:id|revision|outcome|[a-zA-Z][a-zA-Z0-9]*(?:Id|Revision))$/.test(f)))throw TypeError('Invalid server receipt schema');
  return async function run({execution,approval,readEffects,reconcileEffects,verifyExecution,apply}={}){
    const command=prepareExecutionM7({...execution,tenant});
    if(execution.tenant!==tenant||fp(execution)!==fp(command)||typeof verifyExecution!=='function'||typeof apply!=='function')throw TypeError('Prepared exact execution required');
    const digest=fp(command),proof=freeze(snap(approval));
    if(!exact(proof,['reference','executionDigest','reviewerId','expiresAt'])||!id(proof.reference)||proof.executionDigest!==digest||!id(proof.reviewerId)||!Number.isSafeInteger(proof.expiresAt))throw fail('CORE_FORBIDDEN','undisclosed');
    const reads=freeze(normalizeLocalEffectsM7(snap(readEffects),command.targets)),inspects=freeze(normalizeLocalEffectsM7(snap(reconcileEffects),command.targets));
    const meta={scope:JSON.stringify(['core.execution.v7',tenant,command.scope]),key:command.key,fingerprint:digest,actor:command.actor,correlationId:randomUUID()};
    let stage='beforeClaim',state='unconfirmed',evidence=null;
    const deny=()=>fail('CORE_FORBIDDEN','undisclosed');
    const invoke=async(fn,input)=>{let allowed;try{allowed=await fn(input);}catch{}if(allowed!==true)throw deny();};
    const check=async(s)=>{stage=s;const context=freeze({command,digest,approval:proof,stage,correlationId:meta.correlationId,evidence});
      for(const effect of command.effects)await invoke(authorizeExecution,{...context,effect});
      await invoke(verifyApproval,context);
    };
    const access=async(s,kind,effects)=>{stage=s;for(const effect of effects)await invoke(authorizeAccess,{command,digest,stage,kind,effect,correlationId:meta.correlationId});};
    const validateReceipt=v=>{const r=snap(v);if(!exact(r,schema.fields)||Object.entries(r).some(([k,v])=>k.toLowerCase().endsWith('revision')?!(Number.isSafeInteger(v)&&v>0):!id(v)))throw fail('CORE_RECEIPT_INVALID');return r;};
    const envelope=r=>({schema:schema.version,approvalDigest:fp(proof),receipt:validateReceipt(r)});
    const unpack=r=>{if(!exact(r,['schema','approvalDigest','receipt'])||r.schema!==schema.version||r.approvalDigest!==fp(proof))throw deny();return validateReceipt(r.receipt);};
    try{
      await check('beforeClaim');
      let committed;
      try{
        committed=await transaction(async tx=>{
          const claim=await tx.claim(meta);
          await check('afterClaim');
          if(claim?.state==='replay'){state='committed';return {replayed:true,record:claim.result};}
          if(claim?.state!=='claimed')throw deny();
          const locked=[];
          for(const target of command.targets)locked.push({target,row:await tx.lockDomain(target)});
          evidence=freeze(snap(locked));
          for(const r of command.expectedRevisions)if((locked.find(x=>targetKey(x.target)===targetKey(r.target)).row?.revision??null)!==r.revision)throw fail('CORE_REVISION_CONFLICT');
          await invoke(verifyExecution,{command,digest,evidence});
          await check('afterLocks');
          const record=envelope(await apply(Object.freeze({insertDomain:tx.insertDomain,replaceDomain:tx.replaceDomain,enqueueCanonical:tx.enqueueCanonical}),command,evidence));
          await tx.appendAudit({...meta,outcome:'committed',approvalRef:proof.reference,effects:command.effects.map(e=>e.operation)});
          await tx.complete({...meta,result:record});
          await check('beforeCommit');
          return {replayed:false,record};
        },{targets:command.targets});
        state='committed';
      }catch(error){
        if(error?.code!=='CORE_COMMIT_UNKNOWN')throw error;
        state='unknown';evidence=null;
        await check('beforeReconcile');await access('reconcile','inspect',inspects);
        let found;try{found=await inspectCommitted(meta);}catch{throw fail('CORE_COMMIT_UNKNOWN','unknown');}
        if(found?.state!=='committed'||found.fingerprint!==digest)throw fail('CORE_COMMIT_UNKNOWN','unknown');
        state='committed';committed={replayed:true,record:found.result};
      }
      evidence=null;
      await check('beforeDisclosure');await access('readProjection','read',reads);
      const receipt=freeze(unpack(committed.record));
      let projected;
      try{projected=snap(await projectResult(receipt,{command,readEffects:reads,correlationId:meta.correlationId}));}catch{throw deny();}
      // Flat, server-owned receipt projection only; no arbitrary nested or derived fields.
      if(!projected||typeof projected!=='object'||Array.isArray(projected)||Object.keys(projected).some(k=>!Object.hasOwn(receipt,k)||projected[k]!==receipt[k]||!reads.some(e=>e.fields.includes(k)&&command.targets.length===1)))throw deny();
      await check('afterProjection');await access('afterProjection','read',reads);
      return {replayed:committed.replayed,result:projected};
    }catch(error){
      if(error?.code==='CORE_FORBIDDEN'){try{await auditDenied({...meta,stage,outcome:'denied',transactionOutcome:state});}catch{}throw deny();}
      if(state==='committed')throw deny();
      throw error;
    }
  };
}
