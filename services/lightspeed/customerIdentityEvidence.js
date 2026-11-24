// Internal customer evidence only. No identity authentication, linking, consent
// mutation or permission to send. Providers are trusted server-owned readers.
import { LightspeedIncompleteReadError } from './readCollection.js';
const fail=()=>{throw new LightspeedIncompleteReadError('Invalid customer evidence.');};
const id=v=>typeof v==='string' && v.length<=256 && v.length>0 && v.trim()===v && !/[\x00-\x1f\x7f]/.test(v);
const sources=['discord','rewards','customer-portal'];
const channels=['email','sms','discord','messenger','whatsapp','phone'];
const stamp=v=>typeof v==='string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().replace('.000Z','Z')===v.replace('.000Z','Z');
function rowsFor(rows,customerId,field,allowed){
  if(!Array.isArray(rows)||rows.length>1000)fail();
  for(const row of rows){
    if(!row||row.customerId!==customerId||!allowed.includes(row[field])||!stamp(row.observedAt))fail();
  }
  return rows;
}
export function projectCustomerIdentity({customerId,links,consents}={}){
  if(!id(customerId))throw new TypeError('Exact customer ID required.');
  const linkRows=rowsFor(links,customerId,'provider',sources);
  const consentRows=rowsFor(consents,customerId,'channel',channels);
  for(const row of linkRows){
    if(!id(row.externalId)||!['verified','unverified','revoked'].includes(row.status))fail();
  }
  for(const row of consentRows){
    if(!['opt-in','opt-out','unknown'].includes(row.status)||!id(row.evidenceId))fail();
  }
  return {
    customerId, coverage:'supplied-evidence-only',
    links:sources.map(provider=>{
      const rows=linkRows.filter(r=>r.provider===provider);
      const accounts=new Set(rows.map(r=>r.externalId));
      const states=new Set(rows.map(r=>r.status));
      const status=rows.length===0?'unknown':accounts.size>1||states.size>1?'conflicting':rows[0].status;
      return {provider,status,requiresReview:true};
    }),
    consents:channels.map(channel=>{
      const rows=consentRows.filter(r=>r.channel===channel);
      const states=new Set(rows.map(r=>r.status));
      // No chronology-based override of a recorded opt-out in this draft.
      const status=states.has('opt-out')?'opt-out':states.size>1?'unknown':rows[0]?.status??'unknown';
      return {channel,status,conflicting:states.size>1};
    }),
    canSend:false
  };
}
export function createCustomerIdentityRead({customers,readLinks,readConsents}={}){
  if(typeof customers?.get!=='function'||typeof readLinks!=='function'||typeof readConsents!=='function')throw new TypeError('Injected customer and evidence readers required.');
  return Object.freeze({
    async get(customerId,{correlationId}={}){
      if(!id(customerId))throw new TypeError('Exact customer ID required.');
      const result=await customers.get(customerId, ...(correlationId===undefined?[]:[{correlationId}]));
      const row=result?.data??result;
      if(row?.id!==customerId)fail();
      const [links,consents]=await Promise.all([readLinks(customerId,{correlationId}),readConsents(customerId,{correlationId})]);
      return projectCustomerIdentity({customerId,links,consents});
    }
  });
}
