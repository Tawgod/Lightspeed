// Compose independently approved, session-bound enrollment requests with the
// existing TOTP adapter and settings router. No client role/header/PIN can
// approve an enrollment. An unaudited "true" override is deliberately absent.
export function createStaffApprovedEnrollmentAdapters({ approvals } = {}) {
  if (['status','start','allowConfirmation','finish'].some(
    name => typeof approvals?.[name] !== 'function'
  )) throw new TypeError('Durable factor approvals are required.');

  async function authorizeSettings({ request, action }) {
    // Enrollment STATUS returns no secret; the router independently verifies
    // the active, signed employee session first.
    if (action === 'authenticator.status') return true;
    const current = await approvals.status({ context: request });
    if (action === 'authenticator.enroll') return current.state === 'approved';
    if (action === 'authenticator.confirm') return current.state === 'started';
    return false;
  }

  async function authorizeEnrollment({ context, phase }) {
    if (phase === 'begin') return await approvals.start({ context }) === true;
    if (phase === 'confirm') return await approvals.allowConfirmation({ context }) === true;
    if (phase === 'finish') return await approvals.finish({ context }) === true;
    return false;
  }
  return Object.freeze({ authorizeSettings, authorizeEnrollment });
}
