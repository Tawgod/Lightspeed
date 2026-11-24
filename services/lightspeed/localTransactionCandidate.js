import { randomUUID } from 'node:crypto';
import { fingerprintLightspeedPayload } from './idempotency.js';

// Local-only transaction primitive. No vendor calls, no production wiring.
// Adapter must bind every method to ONE checked-out database connection.
export function createLocalTransactionCandidate({ transaction, authorize, auditDenied } = {}) {
  if (![transaction,authorize,auditDenied].every(fn=>typeof fn==='function')) throw new TypeError('Explicit transaction and Security adapters required.');
  return async function run({ scope,key,operations,context,payload,apply } = {}) {
    if (typeof scope!=='string'||!/^test:[a-z0-9_.:-]{1,100}$/.test(scope) ||
        typeof key!=='string'||!/^[A-Za-z0-9_.:-]{8,150}$/.test(key) ||
        !Array.isArray(operations)||!operations.length||operations.some(x=>typeof x!=='string'||!/^[a-z][a-z0-9_.:-]{2,95}$/.test(x)) ||
        new Set(operations).size!==operations.length||typeof apply!=='function') throw new TypeError('Invalid local candidate command.');
    const required=Object.freeze([...operations].sort());
    const fingerprint=fingerprintLightspeedPayload({operations:required,payload});
    const snapshot=JSON.parse(JSON.stringify(payload));
    const correlationId=randomUUID();
    const denied=()=>Object.assign(new Error('Local command not authorized.'),{code:'CORE_FORBIDDEN'});
    const check=async()=>{
      for(const operation of required){
        let decision;
        try{decision=await authorize({operation,context,environment:'test',mode:'write',correlationId});}catch{}
        if(decision!==true)throw denied();
      }
    };
    try {
      // First check before opening transaction, then recheck after claim/lock.
      await check();
      return await transaction(async tx=>{
        const claim=await tx.claim({scope,key,fingerprint});
        await check();
        if(claim.state==='replay')return {replayed:true,result:claim.result};
        if(claim.state!=='claimed')throw Object.assign(new Error('Local command conflict.'),{code:'CORE_KEY_CONFLICT'});
        // apply is trusted server code; it must re-read and lock domain state,
        // use only this transaction, and never invoke external side effects.
        const result=await apply(tx,snapshot);
        fingerprintLightspeedPayload(result);
        await tx.appendAudit({scope,key,fingerprint,operations:required,correlationId,outcome:'committed'});
        await tx.complete({scope,key,fingerprint,result});
        return {replayed:false,result};
      });
    }catch(error){
      if(error?.code==='CORE_FORBIDDEN')await auditDenied({scope,key,fingerprint,operations:required,correlationId,outcome:'denied'});
      throw error;
    }
  };
}
