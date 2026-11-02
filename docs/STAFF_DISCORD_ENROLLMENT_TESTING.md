# Hobby Corner — Hobby Bot Admin Invitation and Authenticator Signup

**Status:** In Development / Testing, **unmounted and not deployed**. **Date:** 2026-11-02.

## Intended employee-visible flow

1. In the approved Discord server, an Admin/Owner selects an eligible linked employee with `/hc security_setup`.
2. Hobby Bot checks live member role IDs. The backend authenticates the bot with an independent dedicated secret, checks the exact guild and manager role ID, resolves both Discord IDs to **active, matching Timeclock employees**, applies persistent throttle and verifies `staff.authenticator.invite` for that actor and target.
3. The backend stores only a keyed hash of a random 256-bit invitation token in PostgreSQL, with manager/employee attribution, a 15-minute expiry and immutable issue/redeem events. The link uses the URL fragment: `https://TEST-ORIGIN/staff-security/#invite=<opaque-token>`.
4. Hobby Bot sends the link to the employee's DM. On DM failure, it displays the URL **ephemerally only to the requesting manager**, who must hand it privately to the employee.
5. The employee opens the HTTPS page; the browser immediately removes the fragment from the address bar. They log in using their signed Timeclock session. The page redeems the token in a no-cache JSON POST, never in logs/query parameters.
6. The backend verifies the **current active, signed employee session** belongs to the invite target, consumes the invitation once, then creates an existing session-bound pending enrollment request. Staff cannot POST directly to request enrollment when invitation-only mode is enabled.
7. The Admin/Owner verifies with a **real independent manager passkey / security key / strong managed IdP**, plus exact backend grant `staff.authenticator.enroll`, and approves the pending request ID on the manager passkey test page. **Discord role or PIN alone never approves**.
8. The employee checks approval and starts setup on the protected page. The server generates a TOTP seed encrypted in PostgreSQL, displays a locally generated QR plus backup entry key **only to that employee**, and verifies the six-digit code to activate the factor.

## Code and dependencies

- Bot: `Tawgod/Hobby-Corner-Discord-Bot:feature/security-enrollment-invites-20261102`, draft [PR #3](https://github.com/Tawgod/Hobby-Corner-Discord-Bot/pull/3); `main.py`, `security_invite.py`, `tests/test_security_invite.py`. **Do not merge or deploy bot main yet.**
- Backend: `Tawgod/Lightspeed:feature/shared-lightspeed-services-phase1-20261029`, existing PR #32; `services/security/staffEnrollmentInvitations.js`, `routes/staffEnrollmentInvitations.js`, `db/hc_staff_security_invitations.sql` and the opt-in `enrollmentInvitations` configuration in `staffSecuritySubsystem.js`.
- Endpoint mounting (in an **isolated test application only**): `app.use('/api/staff-auth', staffAuthGateway.router)`, `app.use('/staff-security', subsystem.settingsRouter)`, `app.use('/staff-enrollment-invites', subsystem.invitationRouter)`, and `app.use('/staff-passkey',passkeyRouter)`. These factory routers **are not mounted on production**.
- `enrollmentInvitations` config must provide exact `guildId,staffRoleId,adminRoleId,ownerRoleId,setupOrigin,botSecret,tokenSecret,resolveDiscordEmployee,canInvite`. `resolveDiscordEmployee` must query the live Timeclock linked identity from **trusted backend service credentials**, never request body fields. `canInvite` must check an exact operation-specific Timeclock/security admin permission for the resolved manager and target. Never use a client-supplied `employeeId`.
- The bot needs **new, isolated, test-only** `SECURITY_ENROLLMENT_API_URL`, `SECURITY_ENROLLMENT_PUBLIC_ORIGIN`, `SECURITY_ENROLLMENT_BOT_KEY`, `SECURITY_ENROLLMENT_GUILD_ID`, `SECURITY_OWNER_ROLE_ID` plus existing Timeclock Staff/Admin role IDs. Backend secrets must be held only in a separate protected staging secret store, not GitHub or Discord; dedicated 32+ byte bot and HMAC secrets. Set exact `setupOrigin` equal to `SECURITY_ENROLLMENT_PUBLIC_ORIGIN`.
- `db/hc_staff_security_invitations.sql` is an **unapplied** additive migration. Never run against live Railway/production without authorized database backup and migration planning.

## Tests

Disposable PostgreSQL **hc_test** ONLY:

```sh
HC_TEST_DATABASE_URL=postgres://hc_test:hc_test@127.0.0.1:5432/hc_test \
 node --test --test-concurrency=1 tests/shared-staff-discord-invitation-postgres.test.mjs
node --test tests/shared-staff-invitation-client.test.mjs
```

Test uses synthetic employees 57/58/59, their fake Discord snowflake IDs, a test bot key and a **test-only injected independent manager verifier**. Tests reject missing bot credential, wrong guild, Staff-as-Admin, permission mismatch, wrong/unsigned employee session, invite replay and QR before approval. Successful path validates one-use invite, real signed Timeclock staff session, existing manager-approval audit, locally generated TOTP QR, real RFC6238 six-digit confirmation and active factor status. The manager's independent proof in this specific integration test is **a fixture**, not the actual device passkey: the separate `shared-staff-passkeys-postgres.test.mjs` uses real ES256 authentication verification.

Bot syntax/role tests: `python -m py_compile main.py security_invite.py && python -m unittest discover -s tests -p 'test_security_invite.py' -v`.

## Not yet a live sign-in

- Not deployed: real Discord command is **not available in the active Hobby Bot**, and there is no publicly usable setup URL.
- No separate HTTPS staging host, disposable staff account connected to test Discord, or real manager passkey/owner bootstrap is configured.
- Need independently authenticated Owner first-passkey bootstrap and recovery, exact manager permission provisioning, real iPhone/Android/browser passkey and Google Authenticator acceptance, trusted-proxy rate-limit/security review, live Timeclock legacy bypass remediation and Discord DM privacy review.
- Protect the invitation URL: anyone seeing the fragment can try to redeem it, but the backend rejects anyone except the correctly linked employee with a signed, active Timeclock session. Never paste private invite tokens or QR codes into public Discord channels, tickets, or logs.
- No live employee security state, Railway secrets, production database schemas, Discord bot, or extension release has been changed by this candidate.

**Suggested staging acceptance:** Create a dedicated staging service and disposable Timeclock-backed employee accounts, use a separate test Discord bot/application and restricted guild/roles, obtain owner-approved independent manager passkey bootstrap, then test one real staff enrollment in Google Authenticator. Production approval and migration are separate decisions.
