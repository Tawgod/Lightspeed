# Locked Owner staging HTTPS preview

The Owner staging service in the existing isolated Railway project has a reserved HTTPS RP ID `hc-owner-staging-staging.up.railway.app`, but real Owner enrollment requires the operator's verified Timeclock identity and approved dedicated Timeclock secret/throttle SQL.

This separate default-off entrypoint verifies the restricted Owner runtime PostgreSQL credentials and nine-table security grants before serving any HTTP. It serves only a static preparation screen and `/health` with `ready:false`; PIN/session/passkey/Owner endpoints return HTTP 423. No forms, employee identity, activation, or production grants are exposed.

When real Owner authentication is independently approved, replace the start command with the existing `node staging/owner-security-server.js` after installing matched Timeclock service credentials, verifying the exact canonical employee ID privately and enabling Owner in this isolated project. A passkey enrolled under the Railway staging hostname is not usable at `timcorp-projects.com` without separate enrollment.
