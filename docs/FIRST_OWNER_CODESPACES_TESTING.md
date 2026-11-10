# Owner commissioning — isolated GitHub Codespaces test environment

**Development only.** This configuration is in draft PR #50 and is not deployed.

The .devcontainer configuration provisions Node.js 22 and a private PostgreSQL 16 service with an explicitly disposable `hc_test` database. It uses fixed *non-production* test credentials inside the private Compose network and exposes no Postgres port on the host. It does not mount Railway, Lightspeed or real Timeclock credentials. No development environment is a valid human business ownership verifier.

## How to use your Codespaces allowance

1. Open `Tawgod/Lightspeed` on the `feature/first-owner-passkey-registration-integration-20261110` branch. Choose **Code > Codespaces > Create codespace on this branch**.
2. Allow the devcontainer to initialize. Node dependencies install automatically without package lifecycle scripts; the test-only PostgreSQL service starts inside the Codespace network.
3. In the Codespaces terminal, run the focused tests:

```bash
node --test tests/first-owner-passkey-registration-postgres.test.mjs \
  tests/first-owner-attestation.test.mjs \
  tests/first-owner-commissioning.test.mjs \
  tests/independent-primary-enrollment-approval.test.mjs
```

4. For a quick source validation, run:

```bash
node --check services/security/firstOwnerPasskeyRegistrationCandidate.js
node --check services/security/firstOwnerCommissioning.js
node --check services/security/firstOwnerAttestation.js
```

5. Stop the Codespace when finished to conserve the monthly allowance. Do not configure an automatic production deployment, expose the test Postgres port, or copy live PINs/employee tokens/Owner signing keys into it.

## Validation scope

The disposable PostgreSQL test applies `hc_staff_passkeys.sql`, `hc_admin_delegations.sql`, and the repaired `hc_owner_commissioning.sql` in a temporary schema. It verifies a signature issued by a **test-only ephemeral key**, then executes the existing passkey service with a simulated successful WebAuthn verification to check atomic registration, one-use authorization and rollback on a deliberately failed audit write.

The test does not authenticate a real human, read an actual Timeclock employee, or exercise a physical security key. Those are still separate live acceptance gates. Do not run the first-Owner bootstrap against production just because these tests pass.

## Troubleshooting

- If PostgreSQL is still starting, verify the `db` Compose service is healthy and rerun the focused test; the test refuses connection strings without the disposable `hc_test` name.
- If a test fails, inspect its failure and source before creating a commit or triggering CI; avoid repeated Actions reruns for the same failing commit.
- If the Codespace configuration requires an adjustment, keep changes on a development branch and send them through a reviewed PR.
- GitHub may count Codespaces compute and storage differently from Actions runner minutes. Your reported 180-hour allowance has not been independently verified here. This assistant does not currently have a Codespaces runtime control action, so none was started.
