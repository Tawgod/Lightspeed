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
