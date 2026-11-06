# Hobby Corner — Registered Workstation Test Candidate

**Status:** In Development / automated disposable-PostgreSQL testing. **Not mounted or deployed.**
**Date:** 2026-11-02. **Owner:** Shared Lightspeed Services; Chrome integration and release are separate.

## What exists in the development branches

- `services/security/staffWorkstationsPostgres.js`: a manager-authorized, backend-only device registration method for unique canonical Ed25519 public SPKI keys. Only verified passkey/security-key/OIDC manager assertions plus exact server-side workstation-management permission can register or revoke. Registration is NOT exposed as a public/employee route.
- `db/hc_staff_stations.sql`: **unapplied** device, expiring one-use challenge, revocation generation and append-only security-event tables. Public keys only, never private keys, raw PINs or bearer tokens.
- `routes/staffStationProof.js`: explicitly **unmounted** `/challenge`, `/verify`, and `/session` handler factory. There is no `/enroll`, manager login, reset or production write endpoint.
- `tests/shared-staff-workstations-postgres.test.mjs`: real Ed25519 signing, replay/invalid-signature consumption, session binding, expiration, permission matrix, strong-manager registration denial, revocation and immutable audit on disposable PostgreSQL.
- `tests/shared-staff-station-http.test.mjs`: local HTTP workflow using the existing signed Timeclock staff-session gateway plus actual key signature; checks forged headers, request validation, one-use challenges, session change and immediate revocation.
- `services/security/staffSecurityBridge.js` already consumes a backend verified `verifyWorkstation` callback for exact-operation policy. A station never grants privileged Lightspeed writes by itself.

## Exact cryptographic message and flow (for a future Chrome integration)

1. An independent authenticated manager approves enrollment of one uniquely generated, per-installation Ed25519 key. Backend-only registration stores the public SPKI key and device ID; manager must independently verify that the proposed key belongs to the correct workstation. No universal extension secret.
2. Employee authenticates through the Timeclock-signed session; `POST /challenge` with `{deviceId}`, from that signed session, produces a 32-byte base64url challenge and a UUID challenge ID. This requires durable server-observed-source + employee throttling. Challenge lifetime is 90 seconds.
3. The registered device signs UTF-8 bytes of `hc:staff:station:v1:<challengeId>:<challenge>` with its **own private key** using Ed25519. It sends `{challengeId,signature}` to `POST /verify`, still with the original signed Timeclock session. Signature is base64url.
4. The backend consumes that challenge atomically even if its signature is wrong. If the signed session, device, challenge, expiry, signature, and current device state all match, it returns a signed, five-minute, employee/session/device-generation-bound station token.
5. For an authorized routine operation the browser supplies both its Timeclock bearer token and `X-HC-Station-Proof`. The backend checks signed session, current employee, token HMAC, session binding, expiry and current device generation on every operation. High-impact writes still require fresh independent employee-bound strong proof **plus** exact permission and mutation safeguards.
6. Manager revocation rotates the device generation, immediately invalidating prior station proof. Store the private key non-exportably where feasible, but do **not** claim a plain Chrome extension makes the machine tamper-proof.

## Automated test command (isolated developer machine)

Use **only disposable** database `hc_test`, never Railway production or migrated store data. With PostgreSQL 16 running locally and this branch checked out:

```bash
HC_TEST_DATABASE_URL=postgres://hc_test:hc_test@127.0.0.1:5432/hc_test \
  node --test --test-concurrency=1 \
  tests/shared-staff-workstations-postgres.test.mjs \
  tests/shared-staff-station-http.test.mjs
```

CI provisions a disposable PostgreSQL 16 service and runs this same command as part of `shared-lightspeed-foundation.yml`. Tests use synthetic employee IDs and ephemeral signing keys; the manager-passkey callback in tests is an explicitly controlled **test double**, not a real provider.

## What blocks an employee-facing/manual pilot

- Real manager/device enrollment ceremony, origin/RP-bound WebAuthn passkey or vetted IdP, real operation grants and privileged recovery.
- Securely managing non-extractable per-installation keys in the private Chrome extension, with browser compatibility checks and revocation UX. **Any extension change must follow `CHROME_EXTENSION_RELEASE_QUEUE.md` and current consolidated-extension source review.**
- Review trusted Railway reverse-proxy IP behavior and WAF/abuse controls; only verified `req.ip` can feed login throttle. Do not simply trust incoming `X-Forwarded-For`.
- Resolve legacy Timeclock clock/status name/PIN bypass and preserve clock-in during phased upgrade.
- Isolated dev or staging access controls, manager approval controls, test-only secrets, reliable Postgres backups and recovery runbook.
- Real store Chrome station test, lost/replaced device test, employee sign-out, iPhone/iPad/Android convention login and security assessment.

**No production routes, Railway variables, Postgres schema, extension code or credentials are changed by this milestone.**
