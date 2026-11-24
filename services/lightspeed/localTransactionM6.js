import { randomUUID } from 'node:crypto';
import { fingerprintLightspeedPayload as fp } from './idempotency.js';
const fail=(code,outcome='not_committed')=>Object.assign(Error('M6 fixture operation cannot proceed safely.'),{code,outcome});
const snap=v=>{fp(v);return JSON.parse(JSON.stringify(v));};
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
const id=v=>typeof v==='string'&&v.length>0&&v.length<=512&&!/[\x00-\x1f]/.test(v);
const type=v=>typeof v==='string'&&/^[a-z][a-z0-9_.-]{0,95}$/.test(v);
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(key=>Object.hasOwn(v,key));
const targetKey=t=>JSON.stringify([t.type,t.id]);
const ordered=(a,b)=>a<b?-1:a>b?1:0;
function normalizeEffects(effects,targets){
  if(!Array.isArray(effects)||!effects.length)throw TypeError('Exact effects required');
  const normalized=effects.map(e=>{
    if(!exact(e,['operation','target','location','fields'])||!type(e.operation)||!exact(e.target,['type','id'])||!targets.some(t=>targetKey(t)===targetKey(e.target))||!id(e.location)||!Array.isArray(e.fields)||!e.fields.length||e.fields.some(f=>!type(f))||new Set(e.fields).size!==e.fields.length)throw TypeError('Invalid effect scope');
    return {...e,fields:[...e.fields].sort()};
  }).sort((a,b)=>ordered(fp(a),fp(b)));
  if(new Set(normalized.map(fp)).size!==normalized.length)throw TypeError('Duplicate effects');
  return normalized;
}
export function createLocalTransactionM6({tenant,transaction,authorize,authorizeRead,authorizeReconcile,auditDenied,inspectCommitted}={}){
  if(!id(tenant)||![transaction,authorize,authorizeRead,authorizeReconcile,auditDenied,inspectCommitted].every(f=>typeof f==='function'))throw TypeError('Explicit synthetic adapters required');
  return async function run({scope,key,actor,targets,effects,readEffects,reconcileEffects,payload,expectedRevisions,approval=null,verifyLocked,apply,receiptFields,projectResult}={}){
    if(!id(key)||key.length<8||!type(scope)||!scope.startsWith('test.')||!actor||actor.tenant!==tenant||!id(actor.id)||!id(actor.realm)||!['employee','service'].includes(actor.type)||!['none','delegated'].includes(actor.delegation?.kind)||![verifyLocked,apply,projectResult].every(f=>typeof f==='function'))throw TypeError('Invalid synthetic command');
    const a=snap(actor);
    if(!exact(a,['type','id','realm','tenant','delegation'])||a.realm!==a.type|| (a.delegation.kind==='none'?!exact(a.delegation,['kind']):a.type!=='service'||!exact(a.delegation,['kind','subject','id','audience','scope'])||![a.delegation.subject,a.delegation.id,a.delegation.audience,a.delegation.scope].every(id)))throw TypeError('Invalid actor namespace');
    const ts=snap(targets);
    if(!Array.isArray(ts)||!ts.length||ts.some(t=>!exact(t,['type','id'])||!type(t.type)||!id(t.id))||new Set(ts.map(targetKey)).size!==ts.length)throw TypeError('Invalid targets');
    ts.sort((a,b)=>ordered(targetKey(a),targetKey(b)));
    const es=normalizeEffects(snap(effects),ts),rs=normalizeEffects(snap(readEffects),ts),qs=normalizeEffects(snap(reconcileEffects),ts);
    const revisions=snap(expectedRevisions);
    if(!Array.isArray(revisions)||revisions.length!==ts.length||revisions.some(r=>!exact(r,['target','revision'])||!exact(r.target,['type','id'])||!ts.some(t=>targetKey(t)===targetKey(r.target))||!(r.revision===null||Number.isSafeInteger(r.revision)&&r.revision>0))||new Set(revisions.map(r=>targetKey(r.target))).size!==ts.length)throw TypeError('Exact revisions required');
    revisions.sort((a,b)=>ordered(targetKey(a.target),targetKey(b.target)));
    const fields=snap(receiptFields);
    if(!Array.isArray(fields)||!fields.length||new Set(fields).size!==fields.length||fields.some(f=>typeof f!=='string'||! /^(?:id|revision|outcome|[a-zA-Z][a-zA-Z0-9]*(?:Id|Revision))$/.test(f)))throw TypeError('Minimal receipt fields required');
    fields.sort();
    const command=freeze({tenant,environment:'test',scope,key,actor:a,targets:ts,effects:es,readEffects:rs,reconcileEffects:qs,payload:snap(payload),expectedRevisions:revisions,approval:snap(approval),receiptFields:fields});
    const fingerprint=fp(command),correlationId=randomUUID();
    const meta={scope:JSON.stringify([tenant,scope]),key,fingerprint,actor:a,correlationId};
    let stage='beforeClaim',outcome='not_committed',evidence=null;
    const check=async(stageName,adapter=authorize,list=es)=>{
      stage=stageName;
      for(const effect of list){let decision;try{decision=await adapter({command,effect,stage,correlationId,evidence});}catch{}
        if(decision!==true)throw fail('CORE_FORBIDDEN',outcome);}
    };
    const receipt=v=>{
      const r=snap(v);
      if(!exact(r,fields)||Object.entries(r).some(([k,v])=>k.toLowerCase().endsWith('revision')?!(Number.isSafeInteger(v)&&v>0):!id(v)))throw fail('CORE_RECEIPT_INVALID',outcome);
      return r;
    };
    try{
      await check('beforeClaim');
      let result;
      try{
        result=await transaction(async tx=>{
          const claim=await tx.claim(meta);
          if(claim?.state==='replay')outcome='committed';
          await check('afterClaim');
          if(claim?.state==='replay')return {replayed:true,result:receipt(claim.result)};
          if(claim?.state!=='claimed')throw fail('CORE_KEY_CONFLICT');
          const locked=[];
          for(const t of ts){const row=await tx.lockDomain(t);locked.push({target:t,row});}
          evidence=freeze(snap(locked));
          for(const r of revisions){const row=locked.find(x=>targetKey(x.target)===targetKey(r.target)).row;if((row?.revision??null)!==r.revision)throw fail('CORE_REVISION_CONFLICT');}
          if(await verifyLocked({command,evidence})!==true)throw fail('CORE_EFFECT_CHANGED');
          await check('afterLocks');
          const domainTx=Object.freeze({insertDomain:tx.insertDomain,replaceDomain:tx.replaceDomain,enqueueCanonical:tx.enqueueCanonical});
          const r=receipt(await apply(domainTx,command,evidence));
          await tx.appendAudit({...meta,outcome:'committed',effects:es.map(e=>e.operation)});
          await tx.complete({...meta,result:r});
          await check('beforeCommit');
          return {replayed:false,result:r};
        },{targets:ts});
        outcome='committed';
      }catch(error){
        if(error?.code!=='CORE_COMMIT_UNKNOWN')throw error;
        outcome='unknown';evidence=null;
        await check('beforeReconcile');
        await check('reconcile',authorizeReconcile,qs);
        let found;try{found=await inspectCommitted(meta);}catch{throw fail('CORE_COMMIT_UNKNOWN','unknown');}
        if(found?.state!=='committed'||found.fingerprint!==fingerprint)throw fail('CORE_COMMIT_UNKNOWN','unknown');
        outcome='committed';result={replayed:true,result:receipt(found.result)};
      }
      evidence=null;
      await check('beforeDisclosure');
      await check('readProjection',authorizeRead,rs);
      let projected;try{projected=snap(await projectResult(freeze(receipt(result.result)),{command,correlationId}));}catch{throw fail('CORE_PROJECTION_FAILED','committed');}
      await check('afterProjection',authorizeRead,rs);
      return {replayed:result.replayed,result:projected};
    }catch(error){
      if(error?.code==='CORE_FORBIDDEN'){try{await auditDenied({...meta,stage,outcome:'denied',transactionOutcome:outcome});}catch{throw fail('CORE_DENIAL_AUDIT_FAILED',outcome);}}
      if(outcome==='committed'&&error?.outcome!=='committed')throw fail(error?.code??'CORE_PROJECTION_FAILED','committed');
      throw error;
    }
  };
}
