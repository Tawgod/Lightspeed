# Hobby Corner Toolkit — Chrome Web Store release preparation

Status: **Packaging / Store review preparation only. Not published.** Branch: `feature/chrome-web-store-release`, based on `integration/hobby-corner-consolidation`. Keep Railway production running on the consolidated branch.

## Release strategy

- Publish **one unlisted stable extension** under Hobby Corner's existing Chrome Web Store developer publisher. Anyone possessing its listing URL can install it; unlisted is **not** an access control. Require Timeclock login and server-side permissions for protected operations.
- Keep prototype functions behind safe disabled actions until tested. Develop beta features through a separate unpacked extension or, if separately published, a clearly labeled *BETA* listing satisfying Chrome's duplication policy.
- Each approved stable release increments manifest `version` and uploads a new ZIP. Chrome automatically installs approved published versions on computers where the Web Store extension is installed; no per-PC ZIP download required. Already-installed *unpacked* copies must be replaced manually once with the Store version.
- Do not merge this feature branch or upload/publish to Chrome Web Store without review and explicit approval.

## Packaging

Run `python scripts/build-chrome-web-store.py` at the repo root. It produces `dist/Hobby-Corner-Toolkit-CWS-v<version>.zip` with **manifest.json at the ZIP root** and generated PNG icons (16, 48, 128). This does not modify existing extension files, service configuration, or Chrome Web Store state.

GitHub Actions workflow `.github/workflows/chrome-web-store-package.yml` runs syntax checks, builds/verifies the ZIP, and stores it as a downloadable workflow artifact. It **does not** use Chrome Web Store credentials and does not publish.

## Suggested listing content (must be verified against shipped features)

**Name:** Hobby Corner Lightspeed Toolkit

**Short description:** Store operations companion for Hobby Corner: order tools, Timeclock integration, and read-only product review.

**Single purpose:** Support authorized Hobby Corner store employees in everyday Lightspeed Retail X-Series workflows, including sales/order utilities, employee Timeclock access, and supplier product review.

**Suggested listing overview:**
Hobby Corner Lightspeed Toolkit helps authorized store employees work with Lightspeed Retail X-Series and Hobby Corner's internal services from Chrome. It provides order split and work-order tools, Timeclock integration, and a read-only supplier product review preview. Some functions require individual employee authorization and may be unavailable until enabled by the store. The extension is intended for Hobby Corner internal operations.

**Visibility:** Unlisted. **Category:** Productivity (if available in the dashboard). **Support:** use a business-owned support email.

**Screenshots:** Capture the *actual extension running* (popup and scanner review) and remove customer/employee personal data from screenshots. Do not use mockups that suggest disabled write operations work.

## Privacy and permission review — REQUIRED BEFORE SUBMISSION

Actual manifest permissions: `activeTab` and `scripting` for on-demand supplier page capture; `tabs` for detecting active Lightspeed tabs and messaging; `storage` for the supplier scanner draft; host permissions for Lightspeed and the three explicitly named Railway hosts.

Review existing active code paths and data flows carefully:
- Timeclock employee PIN is sent over HTTPS to the Hobby Corner scanner gateway for authentication. Its signed session token remains in memory in the scanner review window; do not log or persist a PIN.
- Sale references and order details are requested from the Hobby Corner Lightspeed API, and Timeclock employee information may be sent to Timeclock backend services.
- The scanner reads the currently active supplier product page **only upon explicit employee action**; a draft of supplier product metadata is stored in Chrome local extension storage to open the review window.
- Product identifiers are sent to a Hobby Corner backend that consults Special Orders/Lightspeed to check duplicates. Product updates are disabled in the current scanner beta.
- Separately assess sensitive user/employee information, any retention/analytics/third parties, and operational access controls with the store owner before finalizing the Chrome Web Store Privacy practices declarations.
- Provide a **publicly accessible, accurate privacy policy URL** and a support contact. An internal README or unlisted Google Doc by itself is not sufficient. Do not assert that no personal data is collected without auditing Timeclock and order flows.
- Chrome Web Store requires explanation of broad permissions and how they relate to the extension's stated purpose; remove unnecessary permissions or functionality before submitting.
- New 2026 user-data transparency requirements apply. Relevant official docs:
  https://developer.chrome.com/docs/webstore/prepare
  https://developer.chrome.com/docs/webstore/user_data
  https://developer.chrome.com/blog/cws-policy-updates-2026

## Manual dashboard steps

1. Sign into https://chrome.google.com/webstore/devconsole using the existing developer account. Check publisher profile / 2-step verification and any outstanding verification steps.
2. Review the GitHub Actions build artifact. When the code and disclosures are accepted, upload the ZIP to **New Item**.
3. Complete the Store listing, Privacy practices, and Distribution tabs. Select **Unlisted**.
4. Upload screenshots from the real extension and supply the privacy policy URL and support email.
5. Submit for review. Do not assume acceptance or publication before the dashboard confirms it.
6. After approval, install the Web Store extension on one designated testing computer; ensure the unpacked copy is disabled to prevent duplicate functionality. Validate sign-in, order tools, scanner read-only matching, and auto-update behavior.
7. Once accepted, install the Store version once on the remaining PCs. Future updates follow versioned uploads and review.

**No Chrome Web Store API token, OAuth key, Google login password, or developer credentials should be committed to GitHub or entered into the extension.** Store automation can be added later using the supported Chrome Web Store API with scoped secrets and approval gates.
