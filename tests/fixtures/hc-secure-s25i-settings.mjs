// Offline policy-design fixtures only; no live mutation or authorization.
import {createHash} from 'node:crypto';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const integer=Number.isSafeInteger;
const id=x=>typeof x==='string'&&/^[A-Za-z0-9_.:-]{1,150}$/.test(x);
const deny=reason=>({allowed:false,reason});
export function boundedDecisionExpiry({now,maxMs,deadlines}={}){
 if(!integer(now)||!integer(maxMs)||maxMs<=0||!integer(now+maxMs)||!Array.isArray(deadlines)||!deadlines.length||deadlines.some(x=>!integer(x)||x<=now))return null;
 return Math.min(now+maxMs,...deadlines);
}
// Explicit fixture policy; no production defaults or limits selected.
export function createSettingsFixture({minMs,maxMs,previewMs,authorize,clock,initial}={}){
 if(!integer(minMs)||minMs<=0||!integer(maxMs)||maxMs<minMs||!integer(previewMs)||previewMs<=0||typeof authorize!=='function'||typeof clock!=='function'||!initial||!integer(initial.value)||initial.value<minMs||initial.value>maxMs||!integer(initial.revision)||initial.revision<1)throw TypeError('invalid fixture configuration');
 let current={value:initial.value,revision:initial.revision},audit=[],previews=new Map(),receipts=new Map(),serial=0;
 const valid=v=>integer(v)&&v>=minMs&&v<=maxMs;
 const auth=(actor,action,revision)=>id(actor)&&authorize({actor,action,revision})===true;
 return {
 read(actor){return auth(actor,'read',current.revision)?{allowed:true,...current}:deny('denied')},
 preview({actor,value,revision,reason}={}){
 const now=clock();
 if(!auth(actor,'preview',current.revision))return deny('denied');
 if(revision!==current.revision)return deny('stale');
 if(!valid(value)||typeof reason!=='string'||!reason.trim()||reason.length>250||!integer(now)||!integer(now+previewMs))return deny('invalid');
 const p={actor,value,revision,reason:reason.trim(),expiresAt:now+previewMs,oldValue:current.value};
 const previewId=hash([++serial,p]);previews.set(previewId,p);
 return {allowed:true,previewId,oldValue:p.oldValue,value,revision,expiresAt:p.expiresAt};
 },
 confirm({actor,previewId,key,revision}={}){
 const now=clock();
 if(!auth(actor,'confirm',current.revision))return deny('denied');
 if(!id(key)||!integer(now))return deny('invalid');
 const fingerprint=hash([actor,previewId,revision]);
 if(receipts.has(key)){const r=receipts.get(key);return r.fingerprint===fingerprint&&auth(actor,'read',current.revision)?{allowed:true,status:'previously-committed',revision:r.revision}:deny('conflict-or-denied')}
 const p=previews.get(previewId);
 if(!p||p.actor!==actor||p.expiresAt<=now)return deny('preview');
 if(revision!==p.revision||revision!==current.revision)return deny('stale');
 if(!auth(actor,'change',current.revision))return deny('denied');
 if(!integer(current.revision+1))return deny('revision');
 const next={value:p.value,revision:current.revision+1};
 audit.push({actor,oldValue:current.value,newValue:next.value,revision:next.revision,reason:p.reason,at:now});
 current=next;previews.delete(previewId);receipts.set(key,{fingerprint,revision:next.revision});
 return {allowed:true,status:'committed',revision:next.revision};
 },
 audit(actor){return auth(actor,'audit',current.revision)?{allowed:true,events:structuredClone(audit)}:deny('denied')}
 };
}
