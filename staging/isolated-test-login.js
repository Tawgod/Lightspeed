import {createStaffAuthGateway} from '../services/staffAuthGateway.js';
import {createPostgresStaffLoginThrottle} from '../services/security/staffLoginThrottle.js';
import {createIsolatedTestIdentity} from './isolated-test-identity.js';

// Explicitly mounts ONLY signed PIN sessions. Not invitations, manager
// approvals, TOTP QR seeds, or production Lightspeed/Timeclock routes.
export function createIsolatedTestLoginMount({
  environment=process.env,pool
}={}){
  if(environment.HC_STAGING_TEST_LOGIN_ENABLED!=='true')
    throw new Error('Staging PIN login is not enabled.');
  if(environment.NODE_ENV!=='test'||environment.HC_SECURITY_ENV!=='isolated-staging'||
     typeof pool?.connect!=='function')
    throw new Error('Staging login requires isolated runtime and durable PostgreSQL.');
  for(const name of ['HC_STAGING_SESSION_SECRET','HC_STAGING_THROTTLE_SECRET']){
    if(typeof environment[name]!=='string'||environment[name].length<32)
      throw new Error('Staging login missing a separate strong service secret.');
  }
  const identity=createIsolatedTestIdentity({environment});
  const throttle=createPostgresStaffLoginThrottle({
    pool,secret:environment.HC_STAGING_THROTTLE_SECRET,
    scope:'hc:isolated-test:pin'
  });
  const gateway=createStaffAuthGateway({
    identity,sessionSecret:environment.HC_STAGING_SESSION_SECRET,
    loginLimiter:({ip})=>throttle.reserve({employeeId:'901',sourceIp:ip})
  });
  function mount(app){
    app.use('/api/staff-auth',gateway.router);
    app.use((_req,res)=>res.status(503).json({
      error:'Authenticator enrollment is not yet enabled in isolated staging.'
    }));
  }
  return Object.freeze({mount,gateway,identity});
}
