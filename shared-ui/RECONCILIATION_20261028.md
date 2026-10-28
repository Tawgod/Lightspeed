# Shared UI foundation reconciliation — 2026-10-28

**Status:** In Development · not merged, not deployed.  
**Baseline:** `integration/hobby-corner-consolidation` (owner-verified `24e9834a6`; recheck the head before merge).  
**Review dependencies:** [PR #16](https://github.com/Tawgod/Lightspeed/pull/16), [PR #24](https://github.com/Tawgod/Lightspeed/pull/24), [PR #25](https://github.com/Tawgod/Lightspeed/pull/25), [PR #26](https://github.com/Tawgod/Lightspeed/pull/26).

## Verified source inventory

| Area | Existing consolidated state | Decision |
| --- | --- | --- |
| `shared-ui/hc.css` | Exact same Git blob (`c98ec1a8`) as PR #16 | **Keep consolidated**; no new copy or broad rewrite |
| `shared-ui/core-ops-compat.css` | Already adapted for Special Orders, Ordering, Preorders and GW Preorders | Let PR #24 own changes; no forked navigation rules |
| `extension/product-scanner/hc-beta.css` | Separate bundled/scoped copy of UI tokens with scanner refinements | Keep for extension CSP; synchronize via tests or a packaging process after PR #26 |
| `extension/popup-beta.css` | Purpose-built popup adapter, repeating some tokens | Keep component-specific overrides; progressively source common tokens from one vendored file |
| Brand assets | In scanner/extension and proposed in PR #24; PR #16 also has `shared-ui/assets/` originals | Use the original approved orange/blue logo; **do not add duplicate binary files in this reconciliation**; PR #24 owns core web wordmark route |
| Shared nav | Hardcoded web toolbars + scoped core compat; PR #24 updates web; PR #25 updates Consignment; PR #26 updates Scanner/Toolkit | Assign one navigation contract per surface and verify routes; **do not copy all three nav implementations into foundation** |
| `shared-ui/clipboard.mjs` | Only PR #16 carried this standalone general-purpose helper | **Port selectively** (this branch); PR #26 has `extension/shared-ui/clipboard.mjs` so reconcile APIs before release |
| `shared-ui/showcase.*` | Sample-only gallery from PR #16, no core runtime dependency | Defer gallery; source includes independent asset paths and old demo nav; avoid introducing a second UX specification |
| `tests/shared-ui-beta.test.mjs` | PR #16 test assumed its own specimen and duplicate logo paths | Replace with focused source-level foundation/clipboard compatibility tests, not stale gallery assumptions |
| `CHANGELOG.md` / `shared-ui/README.md` | PR #16 carries older staging assertions | Replace with current reconciliation note and current cross-PR dependencies, not wholesale stale docs |

## Boundaries and integration contract

- **Design:** Consignment Manager beta remains the preferred visual benchmark: original Hobby Corner wordmark, dark navy tool header, blue actions, shaded card hierarchy, restrained spacing and visible status/permission feedback.
- **Sources:** `shared-ui/hc.css` is the web foundation; app-specific adapters must preserve component scoping. Browser extension files are packaged independently, so extension CSS/assets must be vetted and vendored without leaking onto Lightspeed host styles.
- **Navigation:** All available, approved tool destinations should follow a consistent label and active-page contract. Cross-origin links must be verified; keep test-only destinations clearly labeled. Do not import beta paths as permanent production routes.
- **Clipboard:** Exact text must preserve leading zeros, whitespace, line endings, special characters, and embedded newlines. Rich text is optional and sanitized, with exact plain-text fallback.
- **Permissions:** UI classes and menu entries do not grant access; no order, credit, product creation or timeclock behavior changes are authorized by this reconciliation.
- **Release:** No version bump, packaging, Railway deployment or production merge in this branch.

## Proposed merge/rebase order

1. **PR #24 (core operations):** Rebase onto latest consolidated head; review web logo routes, shared navigation and CSS compatibility, run core ops tests, then merge after acceptance.
2. **PR #25 (Consignment):** First reconcile its base PR #11 / consignment feature branch against current consolidated; update links against the accepted PR #24 contract; test in isolated Consignment beta; merge only after its base is approved.
3. **PR #26 (Scanner/Toolkit):** Rebase against current consolidated and accepted web navigation contract; reconcile extension clipboard with `shared-ui/clipboard.mjs` and scanner permissions/UX tests. Keep this behind explicit Chrome release queue clearance.
4. **This selective PR #16 reconciliation:** The already-identical CSS does not need merging; merge unique clipboard + fresh tests/docs after validating interactions with PR #26 (or land clipboard before PR #26 to give it a canonical source). **Do not merge stale PR #16 wholesale**; close/supersede after unique scope is accounted for.

This is a dependency-oriented sequence, not permission to deploy. PR #25 can proceed in its isolated test environment while web PR #24 is under review, but should not claim unified production navigation until its destinations are verified.

## Verification gates

- Test `node --test tests/shared-ui-reconciliation.test.mjs`.
- Validate cross-tool routes from PR #24, #25 and #26 using real environment pages at keyboard and 200% zoom; verify original logos with accessible alt text.
- Check for identical/near-identical CSS or image assets before any further copies and document why extension CSP requires local variants.
- Run Scanner / Consignment / core web integration suites on their *merged candidate* commit, not only isolated PR heads.
- Record **implemented, tested, deployed** separately. Current branch: implemented (clipboard/tests/docs), automated tests pending, deployed **no**.

## PR #16 unique-file disposition audit — 2026-10-28

Cleaned authoritative manager matrix (HOBBY_CORNER_PROJECT.md) overrides older PR #25/#11 and PR #13 references: current Consignment candidate is **PR #30**, and current PO Companion candidate is **PR #31**. PR #24 and #26 remain current navigation coordination owners.

| PR #16 file | Evidence and disposition |
| --- | --- |
| `shared-ui/hc.css` | Exact blob `c98ec1a8` already in consolidated; **preserved, no merge** |
| `shared-ui/clipboard.mjs` | Exact blob `24867110` preserved in PR #27. Also exact same blob at `extension/shared-ui/clipboard.mjs` in PR #26; **clipboard API/implementation parity verified** |
| `shared-ui/assets/hc-icon.webp`, `hc-wordmark.webp` | Source-derived original branding already represented by purpose-specific scanner images and proposed web wordmark in PR #24; **omit redundant files**, preserve original orange/blue brand standard |
| `shared-ui/README.md` | Earlier installation/deployment expectations are now stale; **replaced functionally** by this current ownership, integration and acceptance guide and manager SHARED_ADDON_UI_UX.md |
| `shared-ui/showcase.html`, `shared-ui/showcase.mjs` | Demo-only illustrative UI; no production runtime dependency. Older sidebar/navigation and binary logo relative paths do not match the coordinated navigation or current web asset route. **Do not port**: current actual Consignment beta plus targeted feature acceptance are the stronger maintained visual examples |
| `tests/shared-ui-beta.test.mjs`, `.github/workflows/shared-ui-beta-tests.yml` | Old tests depend on the retired gallery and asset paths; **replaced** by `tests/shared-ui-reconciliation.test.mjs` and dedicated CI. Feature/Chromium checks live with PR #24 and PR #26 |
| `CHANGELOG.md` | Stale unreleased feature-branch snapshot; **replaced** by current reconciliation note, manager handoff and current PR history |

**Conclusion:** There is no outstanding, still-useful unique runtime feature requiring whole-branch PR #16 integration. PR #16 **can be closed as superseded**, retaining it for historical review. Do not delete source history.

### Updated current dependency order
1. Reconcile/accept PR #24 core navigation and brand routes, then validate current core ops pages.
2. PR #27 may merge independently after its own tests and review; its clipboard module is already API/byte-identical to PR #26, so there is no outstanding helper incompatibility.
3. PR #26 must rebase onto accepted consolidated base for extension integration; it owns Chrome popup/scanner navigation and the vendored exact clipboard helper. Coordinate with #22 (Timeclock/Split), #31 (PO Companion), and PR #30 for approved Consignment launcher semantics.
4. PR #30 owns current Consignment consolidation; old #11 and #25 remain historical, not independent integration targets.
5. Complete real browser/employee checks and release queue reconciliation before any extension packaging; none is authorized by these shared UI changes.

### Outstanding acceptance
- Browser navigation clickthrough (real current routes), active-page indication, original wordmark across widths, keyboard focus/escape/return focus, zoom at 100/125/200%, high-contrast/error/empty states.
- Scanner real employee PIN, supplier capture and permission prompts; no Lightspeed product writes.
- Popup/Scanner automated mock Chromium tests in PR #26 are **not a substitute** for real employee/host acceptance.
- Compare merged candidate commit and Railway/extension artifact separately before claiming any rollout.
