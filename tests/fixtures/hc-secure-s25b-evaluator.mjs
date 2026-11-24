// DESIGN-ONLY fixture. Never import into application/runtime code.
export function evaluateSyntheticAuthorization(input){
  // Offline fixture only: all identity, site, grants and approval facts are synthetic.
  const deny=reason=>({allowed:false,reason});
  if(!input||input.fixtureOnly!==true||!Number.isSafeInteger(input.now))return deny("invalid-fixture");
  const {actor,session,effects,grants,restrictions,now}=input;
  if(!actor||actor.realm!=="employee"||actor.active!==true||!session||session.actorId!==actor.id||session.active!==true||session.expiresAt<=now||!Number.isSafeInteger(session.expiresAt))return deny("session");
  if(session.revoked!==false||session.locked!==false)return deny("session");
  if(session.siteVerified!==true||session.deviceVerified!==true||session.method!=="timeclock-pin")return deny("site-or-assurance-review");
  if(!Array.isArray(effects)||!effects.length||!Array.isArray(grants)||!Array.isArray(restrictions))return deny("effects");
  const keys=["tenant","environment","location","resource","field"];
  const validScope=s=>s&&keys.every(k=>typeof s[k]==="string"&&s[k].length>0&&s[k]!=="*"&&s[k]!=="unknown");
  const validEntry=e=>e&&typeof e.operation==="string"&&validScope(e.scope)&&Number.isSafeInteger(e.expiresAt)&&typeof e.revoked==="boolean";
  if(!grants.every(validEntry)||!restrictions.every(validEntry))return deny("invalid-policy");
  const matches=(g,e)=>g.operation===e.operation&&keys.every(k=>g.scope[k]===e.scope[k])&&g.revoked===false&&g.expiresAt>now;
  for(const e of effects){
    if(!e||!validScope(e.scope)||typeof e.operation!=="string"||e.registryState!=="synthetic-approved")return deny("unknown-effect");
    if(e.operation.startsWith("security.")||e.assurance!=="on-site-business")return deny("security-assurance-review");
    if(restrictions.some(g=>matches(g,e)))return deny("restriction");
    if(!grants.some(g=>matches(g,e)))return deny("missing-grant");
    if(e.approvalRequired!==false)return deny("approval-contract-review");
  }
  return {allowed:true,reason:"synthetic-allow"};
}
