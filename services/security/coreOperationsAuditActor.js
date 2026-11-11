// Trusted actor attribution for the OPTIONAL Core Operations security cutover.
// In the current legacy mode existing actor attribution remains unchanged.
// Once the independently verified route guard is enabled, never use
// browser-supplied changed_by/created_by/reviewed_by strings as audit identity.
const STAFF_ID = /^[0-9]{1,18}$/;
const SERVICE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

function unavailable() {
  return Object.assign(new Error('Verified Core Operations actor unavailable.'), {
    status: 403,
    code: 'HC_CORE_OPERATIONS_ACTOR_UNVERIFIED'
  });
}

export function coreOperationsAuditActor(request, legacyActor, { guardEnabled = false } = {}) {
  if (!guardEnabled) return legacyActor;

  // This property must be assigned by trusted
  // createCoreOperationsRouteAdmission.middleware only.
  const admission = request?.hcCoreOperationsAdmission;
  if (!admission || typeof admission !== 'object' ||
      typeof admission.operation !== 'string' ||
      admission.operation.length === 0) throw unavailable();

  if (admission.principal === 'employee' &&
      typeof admission.identityId === 'string' &&
      STAFF_ID.test(admission.identityId)) {
    return 'employee:' + admission.identityId;
  }
  if (admission.principal === 'service' &&
      typeof admission.identityId === 'string' &&
      SERVICE_ID.test(admission.identityId)) {
    return 'service:' + admission.identityId;
  }
  throw unavailable();
}
