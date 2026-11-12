import { TOOL_OPERATIONS } from './adminPermissionCatalog.js';
import { CORE_OPERATIONS_ROUTE_INVENTORY } from './coreOperationsRouteInventory.js';
import {
  classifyRequestedStatus, STATUS_PROGRESS_OPERATION,
  STATUS_SENSITIVE_OPERATION, STATUS_POLICY_VERSION
} from './coreOperationsStatusTransitions.js';

// Development-only, unmounted authorization boundary for the Core Operations
// router. No existing route is permitted unless trusted server configuration
// explicitly approves its full source + HTTP method + path + caller type.
// In particular, the review-pending route inventory is NEVER a grant.
const DENIED = () => Object.assign(new Error('Core Operations access denied.'), {
  status: 403, code: 'HC_CORE_OPERATIONS_FORBIDDEN'
});
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const SOURCE = new Set(['special-orders.js', 'routes/specialOrderProducts.js']);
const SERVICE_OPERATION = /^service\.[a-z][a-z0-9.-]{2,95}$/;
const SERVICE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

function routePattern(template) {
  if (typeof template !== 'string' || !template.startsWith('/')) throw new TypeError('Invalid route.');
  const parts = template.slice(1).split('/');
  if (!parts.length || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part) &&
    !/^:[A-Za-z][A-Za-z0-9_]*$/.test(part))) throw new TypeError('Invalid route template.');
  const pattern = parts.map(part => part.startsWith(':') ? '[A-Za-z0-9_-]{1,128}' : part);
  return new RegExp('^/' + pattern.join('/') + '$');
}

function compiledApproval(route) {
  if (!route || typeof route !== 'object' || !SOURCE.has(route.source) ||
      !METHODS.has(route.method) || !['employee', 'service'].includes(route.audience) ||
      typeof route.operation !== 'string') throw new TypeError('Explicit trusted route approval required.');
  const match = CORE_OPERATIONS_ROUTE_INVENTORY.filter(item =>
    item.source === route.source && item.method === route.method && item.path === route.path);
  if (match.length !== 1 || ['public-health', 'session-check'].includes(match[0].kind)) {
    throw new TypeError('Route not eligible for operation admission.');
  }
  // Store API endpoints must NEVER accept Owner/Admin delegation or
  // employee-security operations, even if they exist in the Admin catalog.
  if (route.audience === 'employee' ? !TOOL_OPERATIONS.includes(route.operation)
    : !SERVICE_OPERATION.test(route.operation)) throw new TypeError('Unrecognized tool operation.');

  const statusRoute = route.source === 'special-orders.js' &&
    route.method === 'PATCH' && route.path === '/items/:id/status' &&
    route.audience === 'employee';
  if (route.statusPolicy !== undefined && (
      route.statusPolicy !== STATUS_POLICY_VERSION || !statusRoute ||
      route.operation !== STATUS_SENSITIVE_OPERATION
  )) throw new TypeError('A status policy can only apply to the exact employee status route.');
  // This routine operation is intentionally prohibited as a static route
  // approval: request-body classification and locked DB-origin validation
  // MUST both run to prevent privilege downgrades.
  if (route.operation === STATUS_PROGRESS_OPERATION) {
    throw new TypeError('Routine status updates require the transition classifier.');
  }
  return Object.freeze({
    source: route.source, method: route.method, path: route.path,
    audience: route.audience, operation: route.operation,
    statusPolicy: route.statusPolicy || null,
    pattern: routePattern(route.path)
  });
}

/**
 * The injected staffAccess is an independently authenticated
 * createStaffAccessBaseline / createStaffSecurityAccessGate instance.
 * It MUST verify a signed, active employee session, cryptographic station /
 * MFA, and a separate exact operation grant. req.hcAuth and browser role
 * claims must never be used as proofs.
 *
 * The injected service verifier MUST cryptographically validate a
 * separate, revocable, scoped machine credential, not an employee PIN,
 * legacy admin key, Origin, role header, or client-supplied service ID.
 * checkServiceGrant MUST separately authorize the exact operation.
 *
 * This factory is deliberately unmounted and defaults to ZERO approved
 * routes. Route grants will be selected after store-owner policy review.
 */
export function createCoreOperationsRouteAdmission({
  approvedRoutes = [], staffAccess, verifyServiceRequest, checkServiceGrant
} = {}) {
  if (!Array.isArray(approvedRoutes) ||
      (staffAccess !== undefined && typeof staffAccess?.authorize !== 'function') ||
      (verifyServiceRequest !== undefined && typeof verifyServiceRequest !== 'function') ||
      (checkServiceGrant !== undefined && typeof checkServiceGrant !== 'function')) {
    throw new TypeError('Trusted staff and service adapters required.');
  }
  const routes = Object.freeze(approvedRoutes.map(compiledApproval));
  const seen = new Set();
  for (const route of routes) {
    const key = [route.source, route.method, route.path, route.audience].join(' ');
    if (seen.has(key)) throw new TypeError('Duplicate explicit route approval.');
    seen.add(key);
  }

  async function authorize({ request } = {}) {
    const method = request?.method;
    const path = request?.path;
    if (!METHODS.has(method) || typeof path !== 'string' ||
        !path.startsWith('/') || path.length > 256 || path.includes('%') ||
        path.includes('//')) throw DENIED();
    const matches = routes.filter(route => route.method === method && route.pattern.test(path));
    // Colliding param/static entries or employee/service alternatives must not
    // silently select a lower-assurance route.
    if (matches.length !== 1) throw DENIED();
    const route = matches[0];

    if (route.audience === 'employee') {
      if (typeof staffAccess?.authorize !== 'function') throw DENIED();
      // Exact owner-configured split on this one endpoint only. The
      // request controls the proposed target, NOT the backend permission:
      // staffAccess still checks the separately granted operation + factor.
      const transition = route.statusPolicy === STATUS_POLICY_VERSION
        ? classifyRequestedStatus(request.body) : null;
      if (route.statusPolicy && !transition) throw DENIED();
      const operation = transition?.operation || route.operation;
      let admitted;
      try { admitted = await staffAccess.authorize({request, action: operation}); }
      catch { throw DENIED(); }
      if (admitted?.operation !== operation ||
          !/^[0-9]{1,18}$/.test(String(admitted?.employeeId || ''))) throw DENIED();
      return Object.freeze({
        principal: 'employee', identityId: String(admitted.employeeId),
        operation, assurance: admitted.assurance,
        ...(transition ? { statusTarget: transition.status } : {})
      });
    }

    if (typeof verifyServiceRequest !== 'function' || typeof checkServiceGrant !== 'function') {
      throw DENIED();
    }
    let identity;
    try { identity = await verifyServiceRequest(request); }
    catch { throw DENIED(); }
    if (identity?.type !== 'service' || identity?.active !== true ||
        typeof identity.id !== 'string' || !SERVICE_ID.test(identity.id)) throw DENIED();
    const safeIdentity = Object.freeze({id: identity.id, type: 'service', active: true});
    const safeRoute = Object.freeze({source: route.source, method, path: route.path});
    let allowed = false;
    try {
      allowed = await checkServiceGrant({
        identity: safeIdentity, operation: route.operation, route: safeRoute
      }) === true;
    } catch { throw DENIED(); }
    if (!allowed) throw DENIED();
    return Object.freeze({
      principal: 'service', identityId: safeIdentity.id,
      operation: route.operation, assurance: 'scoped-service'
    });
  }

  async function middleware(req, res, next) {
    try {
      const result = await authorize({request: req});
      req.hcCoreOperationsAdmission = result;
      next();
    } catch {
      res.set('Cache-Control', 'no-store');
      res.status(403).json({error: 'Core Operations permission required.'});
    }
  }
  return Object.freeze({authorize, middleware});
}
