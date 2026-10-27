# Hobby Corner Shared Addon UI — beta foundation

**State:** In Development · not merged, deployed, packaged, or published  
**Owner:** Shared Addon UI / UX Coordination  
**Base:** `Tawgod/Lightspeed:integration/hobby-corner-consolidation`  
**Manager specification:** `Tawgod/Hobby-Corner:main/SHARED_ADDON_UI_UX.md`

This is the reusable, **opt-in** beta interface kit for employee tools. It reflects the owner's October 27 blue/navy + shaded-panel design approval and original store logo uploads.

## Contents
- [`hc.css`](./hc.css) — namespaced design tokens, navigation shell, surfaces, panels, cards, buttons, input fields, badges, tables, alerts, dialog, drawer, empty/loading states, responsive layout and focus treatments
- [`showcase.html`](./showcase.html) + [`showcase.mjs`](./showcase.mjs) — self-contained offline **sample-data** component gallery with interactive preview controls; open via a local HTTP server, e.g. `python3 -m http.server 8085` from the repo root and then visit `http://localhost:8085/shared-ui/showcase.html`
- [`clipboard.mjs`](./clipboard.mjs) — exact plain-text clipboard helper with opt-in sanitized rich HTML. Preserves whitespace, newlines, case and leading zeros. Never converts SKU/UPC to a Number
- [`assets/hc-icon.webp`](./assets/hc-icon.webp) — optimized image produced from the store owner's uploaded orange icon
- [`assets/hc-wordmark.webp`](./assets/hc-wordmark.webp) — optimized image produced from the supplied full orange/blue Hobby Corner wordmark

## How to adopt in each tool

**Do not globally inject this file into existing applications or Lightspeed.** Wrap just the owned application/surface root in `class="hc-ui"`, then use explicitly named `hc-*` classes. The stylesheet does not style elements in other applications without that class.

```html
<link rel="stylesheet" href="/YOUR_EXPLICITLY_CONFIGURED_ROUTE/hc.css">
<div class="hc-ui">
  <section class="hc-panel" aria-labelledby="product-section">
    <div class="hc-panel-header"><h2 id="product-section">Products</h2></div>
    <div class="hc-panel-body hc-stack">
      <div class="hc-field">
        <label for="sku">SKU</label>
        <input class="hc-input hc-mono" id="sku" type="text" inputmode="text">
      </div>
      <button class="hc-button" type="button">Preview match</button>
      <p class="hc-alert hc-alert--warning" role="status">Review required before changes.</p>
    </div>
  </section>
</div>
```

**Server-served pages:** the current `server.js` serves named pages and styles through explicit routes. Add and test an explicit CSS/logo route when a feature workstream adopts the kit; the example URL above is not an existing production route. Do not change routing just for the static showcase.

**Chrome extension:** `/extension/download` packages only `extension/`. Copy version-locked UI assets into `extension/shared-ui/` when integrating an actual extension screen, or use the release pipeline to copy them deterministically; a sibling repository directory will NOT be included by default. Scope extension CSS to the extension-owned DOM root, never to the Lightspeed document's global `body` or `button` styles. The extension manifest, popup, scanner, and content script remain unchanged in this foundation PR.

**Cross-workstream coordination:** feature chats should source these files from the shared UI foundation PR, but reconcile their own active branches first. The kit does **not** replace scanner matching, Timeclock PIN authentication, supplier/order state, customer workflows or Lightspeed approval checks. Business controls remain owned by their feature workstreams.

## Semantics and behavior
- Primary = the one next-step action for a decision area. Secondary = safe alternative. Danger = destructive action requiring its own verified confirmation flow. A CSS class grants no permissions.
- `hc-panel` and `hc-inset` have visibly distinct shading and borders; avoid nested white panels blending into one surface.
- `hc-badge` status variants always include a readable label.
- `role="status"` announces informational feedback; use `role="alert"` for actual blocking errors only.
- `<dialog>` controls focus for modal previews. Actual approvals must also show operation, item count, changed fields and side effects, plus backend enforcement.
- Clipboard helper accepts `{plainText}`; optional `formattedHtml` is sanitized to semantic tags and limited styles. Rich copy falls back to exact plain text when the API is unsupported/denied. Clipboard writes must originate from direct user gestures. **No formatting is guaranteed** in a target app that accepts plain text only; never replace original data with a prettified representation.
- Use image assets with correct alt treatment: wordmark `alt="The Hobby Corner"` when it conveys branding; decorative symbol `alt=""` when adjacent brand text is available. Preserve aspect ratios.
- Dark backgrounds are used only in owned navigation chrome for this beta. The kit does not auto-change based on the host application's dark-mode preference.

## Adoption and release gates
1. Inventory and compare each screen's existing layout and permission states.
2. Apply only additive scoped styling on an isolated feature branch, with a before/after screenshot.
3. Check keyboard order, focus, labels, scanner flows, 100%/125%/200% zoom, empty/loading/error, and responsive view.
4. Validate contrast and test copy of formatted descriptions, multiline notes and `000...` identifiers; do not claim full WCAG certification from static palette checks.
5. Run feature tests; verify all business-write restrictions and permission gates remain unchanged.
6. Coordinate branch merge and release through the shared Chrome extension queue or the relevant Railway test environment. No production merge/deploy/extension packaging without its separate approval.

### Validation recorded 2026-10-27
- CSS/style kit and self-contained specimen authored on a non-deployed branch.
- Checked 4.96:1 normal-text contrast for white on #1769e9 blue; 14.23:1 for white on #102c48 navy; muted #4a5e76 on #f6f9fc 6.30:1; semantic alert text on their backgrounds >6:1 in sampled combinations.
- Interactive specimen uses **illustrative records only**, has no fetch/production backend dependency, and performs no business writes.
- Browser acceptance and actual tool adoption are **not yet verified**.
