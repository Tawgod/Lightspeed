# Owner staging locked LOGIN principals (no passwords)

Development-only one-shot isolated staging step. Create `hc_owner_stage_runtime` and `hc_owner_stage_operator` as distinct LOGIN roles with **PASSWORD NULL** (impossible to authenticate using password), no elevated privileges, and a single existing NOLOGIN privilege group each. Refuses existing role collisions, existing Owner activations, production environments or unknown Railway projects. Uses only `Postgres-x8Ui` in `HC PR63 Isolated Staging`. No secrets, employee IDs, passkeys or role activation.

Actual independent passwords and restricted app/operator connections require a private owner-controlled secret setup, after verifying the identity and deciding exact staging hostname. Never place the operator DB URL in the Owner web service. No production Timeclock migration or gateway changes.
