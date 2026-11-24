import { randomUUID } from 'node:crypto';
import { fingerprintLightspeedPayload as fingerprint } from './idempotency.js';

// Separate, opt-in offline contract refinement. V4 exports remain unchanged.
// actor and operations MUST be derived by trusted server code from Security
// and actual effects. This candidate does not verify identity or issue grants.
const fail=code=>Object.assign(new Error('Local transaction cannot proceed safely.'),{code});
const identifier=v=>typeof v==='string'&&/^[A-Za-z0-9_.:-]{1,150}$/.test(v);
const snapshot=v=>{fingerprint(v);return JSON.parse(JSON.stringify(v));};
export function createLocalTransactionM5({transaction,authorize,auditDenied,inspectCommitted}={}){
  if(![transaction,authorize,auditDenied,inspectCommitted].every(f=>typeof f==='function'))throw new TypeError('Explicit offline adapters required.');
  return async function run({scope,key,actor,operations,context,payload,apply,projectResult}={}){
    if(typeof scope!=='string'||!/^test:[a-z0-9_.:-]{1,100}$/.test(scope)||!identifier(key)||key.length<8||
      !actor||!['employee','service'].includes(actor.type)||!identifier(actor.id)||
      !Array.isArray(operations)||!operations.length||new Set(operations).size!==operations.length||
      operations.some(v=>typeof v!=='string'||!/^[a-z][a-z0-9_.:-]{2,95}$/.test(v))||
      typeof apply!=='function'||typeof projectResult!=='function')throw new TypeError('Invalid offline command.');
    const subject=Object.freeze({type:actor.type,id:actor.id});
    const required=Object.freeze([...operations].sort());
    const input=snapshot(payload);
    const digest=fingerprint({actor:subject,operations:required,payload:input});
    const correlationId=randomUUID();
    const meta={scope,key,fingerprint:digest,actor:subject,operations:required,correlationId};
    const check=async()=>{
      for(const operation of required){
        let decision;
        try{decision=await authorize({actor:subject,operation,context,mode:'write',environment:'test',correlationId});}catch{}
        if(decision!==true)throw fail('CORE_FORBIDDEN');
      }
    };
    const project=async result=>{
      await check();
      return snapshot(await projectResult(snapshot(result),{actor:subject,context,correlationId}));
    };
    try{
      await check();
      let committed;
      try{
        committed=await transaction(async tx=>{
          const claim=await tx.claim(meta);
          await check();
          if(claim?.state==='replay')return {replayed:true,result:snapshot(claim.result)};
          if(claim?.state!=='claimed')throw fail('CORE_KEY_CONFLICT');
          const result=snapshot(await apply(tx,snapshot(input)));
          await tx.appendAudit({...meta,outcome:'committed'});
          await tx.complete({...meta,result});
          return {replayed:false,result};
        });
      }catch(error){
        if(error?.code!=='CORE_COMMIT_UNKNOWN')throw error;
        // Adapter must classify commit-ack uncertainty; never blindly re-execute.
        await check();
        let found;
        try{found=await inspectCommitted(meta);}catch{throw fail('CORE_COMMIT_UNKNOWN');}
        if(found?.state!=='committed'||found.fingerprint!==digest)throw fail('CORE_COMMIT_UNKNOWN');
        committed={replayed:true,result:snapshot(found.result)};
      }
      // Projection is evaluated afresh, after commit; failure never undoes commit.
      return {replayed:committed.replayed,result:await project(committed.result)};
    }catch(error){
      if(error?.code==='CORE_FORBIDDEN')await auditDenied({...meta,outcome:'denied'});
      throw error;
    }
  };
}
