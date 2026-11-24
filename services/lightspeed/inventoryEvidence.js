// M1 offline evidence contract. No network, persistence, grants or mutation execution.
// The projection deliberately recognizes only the existing synthetic fixture shape.
const TYPES = ['sale', 'return', 'supplier_receipt', 'transfer', 'adjustment', 'count'];
const SCALE = 1000000n;
function decimal(value) {
  if (typeof value !== 'string' || !/^-?\d{1,12}(?:\.\d{1,6})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.replace(/^-/, '').split('.');
  return (BigInt(whole) * SCALE + BigInt(fraction.padEnd(6, '0'))) * (value.startsWith('-') ? -1n : 1n);
}
function format(value, places = 6) {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(places + 1, '0');
  const fraction = digits.slice(-places).replace(/0+$/, '');
  return (negative ? '-' : '') + digits.slice(0, -places) + (fraction ? '.' + fraction : '');
}
const id = v => typeof v === 'string' && v.length > 0 && v === v.trim();
// Canonical UTC millisecond instants only; adapters must normalize source offsets first.
function instant(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) && new Date(ms).toISOString() === v ? ms : null;
}
const same = (a, b) => a.productId === b.productId && a.outletId === b.outletId && a.variantId === b.variantId;
const validKey = a => a && id(a.productId) && id(a.outletId) && (a.variantId === null || id(a.variantId));
const review = reason => ({ status: 'needsReview', reason, varianceQuantity: null, varianceCost: null, executable: false });
export async function observeOutletInventory({ reader, productId, outletId, clock = () => new Date().toISOString() }) {
  if (!id(productId) || !id(outletId) || typeof reader?.byProduct !== 'function') throw new TypeError('Exact product/outlet and reader required');
  const raw = await reader.byProduct(productId);
  const fetchedAt = clock();
  if (instant(fetchedAt) === null) throw new TypeError('Invalid observation clock');
  const rows = raw?.product_id === productId && Array.isArray(raw.outlets) ? raw.outlets.filter(r => r?.id === outletId) : [];
  const row = rows.length === 1 ? rows[0] : null;
  const level = decimal(row?.current_inventory_level);
  const procure = decimal(row?.quantity_to_procure);
  return { schemaVersion: 'inventory.v0', sourceSystem: 'lightspeed-x', apiVersion: '2026-04', productId, outletId, variantId: null,
    onHand: level === null ? null : format(level), quantityToProcure: procure === null || procure < 0n ? null : format(procure),
    available: null, committed: null, fetchedAt, sourceUpdatedAt: null, snapshotAsOf: null,
    freshnessStatus: 'unknown', coverageStatus: 'unknown', evidenceStatus: 'unverified',
    quantityDefinitions: { onHand: 'candidate-current_inventory_level', available: 'unverified', committed: 'unverified' } };
}
// Inputs are trusted, normalized backend evidence only. No raw webhook/PO/sale adapters yet.
// A count must be a full outlet observation, not a shelf count or additive scan.
export function reconcileInventoryCount({ scan, snapshot, coverage, events, cost, evaluatedAt, maxAgeMs }) {
  if (!validKey(scan) || !validKey(snapshot) || !same(scan, snapshot) || scan.countMode !== 'full-outlet' || !id(scan.scanId)) return review('identity-or-count-mode');
  const start = instant(scan.scannedAt), end = instant(snapshot.snapshotAsOf), now = instant(evaluatedAt);
  if (start === null || end === null || now === null || start >= end || end > now || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0 || now - end > maxAgeMs || snapshot.evidenceStatus !== 'verified' || snapshot.sourceSystem !== 'lightspeed-x') return review('snapshot-time-or-evidence');
  const counted = decimal(scan.countedQuantity), stock = decimal(snapshot.onHand);
  if (counted === null || counted < 0n || stock === null) return review('quantity');
  if (!Array.isArray(coverage) || !Array.isArray(events)) return review('coverage');
  for (const type of TYPES) {
    const matches = coverage.filter(c => c && c.eventType === type && same(c, scan));
    const c = matches[0];
    if (matches.length !== 1 || c.status !== 'complete' || c.paginationComplete !== true || c.effectiveTimeVerified !== true || c.lateArrivalsResolved !== true || instant(c.from) === null || instant(c.through) === null || instant(c.from) > start || instant(c.through) < end || !id(c.sourceRef)) return review('coverage:' + type);
  }
  let expected = counted;
  const seen = new Map();
  for (const e of events) {
    if (!validKey(e)) return review('event-identity');
    if (!same(e, scan)) continue;
    const time = instant(e.occurredAt), delta = decimal(e.quantityDelta);
    if (!TYPES.includes(e.eventType) || time === null || delta === null || !id(e.eventId) || !id(e.sourceRef) || e.effectiveTimeVerified !== true || e.physicalEffectVerified !== true) return review('event-evidence');
    if ((e.eventType === 'sale' && delta >= 0n) || (['return', 'supplier_receipt'].includes(e.eventType) && delta <= 0n)) return review('event-sign');
    if (!coverage.some(c => c && same(c, scan) && c.eventType === e.eventType && c.sourceRef === e.sourceRef)) return review('event-source');
    const fingerprint = JSON.stringify([e.eventType, e.occurredAt, format(delta), e.sourceRef]);
    if (seen.has(e.eventId)) { if (seen.get(e.eventId) !== fingerprint) return review('conflicting-event'); continue; }
    seen.set(e.eventId, fingerprint);
    if (time === start || time === end) return review('ambiguous-boundary-event');
    if (time > start && time < end) expected += delta;
  }
  if (expected < 0n) return review('negative-expected-stock');
  const variance = expected - stock;
  const unitCost = decimal(cost?.unitCost);
  if (unitCost === null || unitCost < 0n || cost?.verified !== true || !id(cost.basis) || !/^[A-Z]{3}$/.test(cost.currency || '')) return review('cost-evidence');
  return { status: 'calculated', expectedQuantity: format(expected), varianceQuantity: format(variance), varianceCost: format(variance * unitCost, 12), currency: cost.currency, costBasis: cost.basis, executable: false };
}
