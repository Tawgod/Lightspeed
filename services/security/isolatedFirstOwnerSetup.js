import {createOperatorFirstOwnerPasskeyCandidate} from './operatorFirstOwnerPasskeyCandidate.js';
import {createFirstOwnerActivationRouter} from '../../routes/firstOwnerActivation.js';

// Explicit isolated TEST environment assembly. No production mount.
// Sign-in MUST use the existing canonical /api/staff-auth/session route.
// This factory deliberately has no ability to issue an activation token.
export function createIsolatedFirstOwnerSetup({
 environment,enabled=false,expectedOwnerEmployeeId,staffAuthGateway,
 timeclockIdentity,pool,origin,rpID,signingSecret,loginThrottle,
 now=()=>Date.now(),webauthn
}={}){
 if(environment!=='test'||enabled!==true)
  throw new TypeError('Initial Owner setup must be explicitly enabled for isolated testing.');
 const candidate=createOperatorFirstOwnerPasskeyCandidate({
  environment,enabled,expectedOwnerEmployeeId,staffAuthGateway,
  timeclockIdentity,pool,origin,rpID,signingSecret,loginThrottle,
  now,webauthn,
  readActivationSecret:context=>context?.get?.('x-hc-owner-activation')
 });
 const router=createFirstOwnerActivationRouter({candidate,origin});
 return Object.freeze({router});
}
