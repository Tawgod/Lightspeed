// Proposed bounded per-trust-class session policy, deliberately unmounted.
// Existing active session TTL is 900s; policy changes require audited durable
// storage, session issuance integration and separately approved rollout.
const classes=Object.freeze(['approved-workstation','remote']);
const ranges=Object.freeze({
 'approved-workstation':Object.freeze({idleMin:300,idleMax:7200,absoluteMin:900,absoluteMax:43200}),
 'remote':Object.freeze({idleMin:300,idleMax:3600,absoluteMin:900,absoluteMax:7200})
});
const DEFAULTS=Object.freeze({
 'approved-workstation':Object.freeze({idleSeconds:900,absoluteSeconds:900}),
 'remote':Object.freeze({idleSeconds:900,absoluteSeconds:900})
});
export const SESSION_CLASSES=classes;
export const DEFAULT_STAFF_SESSION_POLICY=DEFAULTS;
export function validateStaffSessionPolicy(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||
   Reflect.ownKeys(value).some(key=>!classes.includes(key))||
   Reflect.ownKeys(value).length!==classes.length)
   throw new TypeError('Both verified workstation and remote policy are required.');
 const result={};
 for(const kind of classes){
  const entry=value[kind],bounds=ranges[kind];
  if(!entry||typeof entry!=='object'||Array.isArray(entry)||
     Reflect.ownKeys(entry).length!==2 ||
     Reflect.ownKeys(entry).some(key=>!['idleSeconds','absoluteSeconds'].includes(key))||
     !Number.isSafeInteger(entry.idleSeconds)||!Number.isSafeInteger(entry.absoluteSeconds)||
     entry.idleSeconds<bounds.idleMin||entry.idleSeconds>bounds.idleMax||
     entry.absoluteSeconds<bounds.absoluteMin||entry.absoluteSeconds>bounds.absoluteMax||
     entry.idleSeconds>entry.absoluteSeconds)
   throw new TypeError('Session policy is outside safe limits.');
  result[kind]=Object.freeze({idleSeconds:entry.idleSeconds,absoluteSeconds:entry.absoluteSeconds});
 }
 return Object.freeze(result);
}
export function classifyStaffDevice({stationProof}={}){
 // Client "local" flags and IP/Origin are never sufficient to claim trusted location.
 return stationProof?.verified===true &&
   typeof stationProof.deviceId==='string' && stationProof.deviceId.length>0 &&
   Number.isSafeInteger(stationProof.expiresAtMs) &&
   stationProof.expiresAtMs>Date.now()
   ?'approved-workstation':'remote';
}
export function previewStaffSessionPolicy({current=DEFAULTS,next}={}){
 const normalizedCurrent=validateStaffSessionPolicy(current);
 const normalizedNext=validateStaffSessionPolicy(next);
 return Object.freeze(classes.map(kind=>Object.freeze({
  class:kind,before:normalizedCurrent[kind],after:normalizedNext[kind],
  changed:normalizedCurrent[kind].idleSeconds!==normalizedNext[kind].idleSeconds ||
    normalizedCurrent[kind].absoluteSeconds!==normalizedNext[kind].absoluteSeconds
 })));
}
