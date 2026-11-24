import test from 'node:test';
import assert from 'node:assert/strict';
import { createLightspeedInventoryRead } from '../services/lightspeed/inventory.js';
import { observeOutletInventory, reconcileInventoryCount } from '../services/lightspeed/inventoryEvidence.js';
const t = minute => `2026-11-24T10:${minute}:00.000Z`;
const key = { productId: '0001', outletId: '01', variantId: null };
const types = ['sale', 'return', 'supplier_receipt', 'transfer', 'adjustment', 'count'];
const fixture = () => ({ scan: { ...key, scanId: 'scan-1', countMode: 'full-outlet', scannedAt: t('00'), countedQuantity: '8' }, snapshot: { ...key, sourceSystem: 'lightspeed-x', snapshotAsOf: t('30'), onHand: '5', evidenceStatus: 'verified' }, coverage: types.map(eventType => ({ ...key, eventType, status: 'complete', paginationComplete: true, effectiveTimeVerified: true, lateArrivalsResolved: true, from: t('00'), through: t('30'), sourceRef: 'fixture-' + eventType })), events: [], cost: { unitCost: '2.25', currency: 'USD', basis: 'fixture', verified: true }, evaluatedAt: t('31'), maxAgeMs: 60000 });
const event = (eventType, quantityDelta, minute = '15', eventId = 'e1') => ({ ...key, eventType, quantityDelta, occurredAt: t(minute), eventId, sourceRef: 'fixture-' + eventType, effectiveTimeVerified: true, physicalEffectVerified: true });
test('uses existing reader, preserves exact outlet, never guesses availability or freshness', async () => {
  const calls = [];
  const reader = createLightspeedInventoryRead({ transport: { request: async path => { calls.push(path); return { data: { product_id: '0001', outlets: [{ id: '01', current_inventory_level: '0', quantity_to_procure: '4', available: '99' }, { id: '1', current_inventory_level: '7' }] } }; } } });
  const r = await observeOutletInventory({ reader, productId: '0001', outletId: '01', clock: () => t('30') });
  assert.deepEqual(calls, ['/api/2026-04/inventory/0001']);
  assert.equal(r.onHand, '0'); assert.equal(r.quantityToProcure, '4'); assert.equal(r.available, null); assert.equal(r.committed, null); assert.equal(r.snapshotAsOf, null); assert.equal(r.freshnessStatus, 'unknown');
});
test('missing, duplicate, wrong product and numeric-only candidate stock remain unknown', async () => {
  for (const raw of [{ product_id: '0001', outlets: [] }, { product_id: '0001', outlets: [{ id: '01', current_inventory_level: '8' }, { id: '01', current_inventory_level: '8' }] }, { product_id: '1', outlets: [{ id: '01', current_inventory_level: '8' }] }, { product_id: '0001', outlets: [{ id: '01', current_inventory_level: 8 }] }]) {
    assert.equal((await observeOutletInventory({ reader: { byProduct: async () => raw }, productId: '0001', outletId: '01', clock: () => t('30') })).onHand, null);
  }
});
test('post-scan sale and receipt, exact signed valuation, out-of-order and duplicate events', () => {
  const f = fixture(); const sale = event('sale', '-2'); f.events = [event('supplier_receipt', '1', '20', 'e2'), sale, sale];
  assert.deepEqual(reconcileInventoryCount(f), { status: 'calculated', expectedQuantity: '7', varianceQuantity: '2', varianceCost: '4.5', currency: 'USD', costBasis: 'fixture', executable: false });
  f.snapshot.onHand = '8.5'; assert.equal(reconcileInventoryCount(f).varianceCost, '-3.375');
});
test('ignores another outlet and preserves exact fractional calculation', () => {
  const f = fixture(); f.scan.countedQuantity = '5.1'; f.cost.unitCost = '0.2'; f.events = [{ ...event('sale', '-2'), outletId: '1' }]; assert.equal(reconcileInventoryCount(f).varianceCost, '0.02');
});
test('fails closed for missing coverage, unresolved late arrivals, stale or unverified snapshot', () => {
  for (const change of [f => f.coverage.pop(), f => { f.coverage[0].lateArrivalsResolved = false; }, f => { f.maxAgeMs = 1; }, f => { f.snapshot.evidenceStatus = 'unverified'; }, f => { f.snapshot.snapshotAsOf = null; }]) { const f = fixture(); change(f); assert.equal(reconcileInventoryCount(f).status, 'needsReview'); }
});
test('rejects unknown, pending, wrong-sign and conflicting physical events', () => {
  for (const events of [[event('unknown', '2')], [{ ...event('supplier_receipt', '2'), physicalEffectVerified: false }], [event('sale', '2')], [event('sale', '-2'), event('sale', '-1')], [{ ...event('sale', '-1'), sourceRef: 'unverified' }]]) { const f = fixture(); f.events = events; assert.equal(reconcileInventoryCount(f).status, 'needsReview'); }
});
test('rejects same-time boundaries, invalid dates, shelf-only and unverified cost', () => {
  for (const change of [f => { f.events = [event('sale', '-1', '00')]; }, f => { f.events = [event('sale', '-1', '30')]; }, f => { f.scan.scannedAt = '2026-02-30T10:00:00.000Z'; }, f => { f.scan.countMode = 'shelf'; }, f => { f.cost.verified = false; }]) { const f = fixture(); change(f); assert.equal(reconcileInventoryCount(f).executable, false); assert.equal(reconcileInventoryCount(f).status, 'needsReview'); }
});

test('linked full reversal is applied once even when supplied out of order', () => {
  const f = fixture(); const sale = event('sale', '-2', '10', 'sale-1');
  const reversal = { ...event('return', '2', '20', 'return-1'), reversalOfEventId: 'sale-1' };
  f.events = [reversal, sale, reversal]; assert.equal(reconcileInventoryCount(f).expectedQuantity, '8');
});
test('reversal of a pre-scan sale changes only post-scan quantity', () => {
  const f = fixture(); f.scan.scannedAt = t('05');
  f.events = [event('sale', '-2', '02', 'sale-1'), { ...event('return', '2', '20', 'return-1'), reversalOfEventId: 'sale-1' }];
  assert.equal(reconcileInventoryCount(f).expectedQuantity, '10');
});
test('rejects missing, partial, duplicate and chronologically invalid linked reversals', () => {
  const sale = event('sale', '-2', '10', 'sale-1');
  const reversal = { ...event('return', '2', '20', 'return-1'), reversalOfEventId: 'sale-1' };
  for (const events of [[reversal], [sale, {...reversal, quantityDelta:'1'}], [sale, reversal, {...reversal, eventId:'return-2'}], [sale, {...reversal, occurredAt:t('09')}], [sale,reversal,{...reversal,reversalOfEventId:'other'}]]) {
    const f = fixture(); f.events = events; assert.equal(reconcileInventoryCount(f).status, 'needsReview');
  }
});
test('rejects impossible intermediate stock even when later receiving restores it', () => {
  const f = fixture(); f.scan.countedQuantity = '1';
  f.events = [event('supplier_receipt','5','20','receipt'),event('sale','-2','10','sale')];
  assert.equal(reconcileInventoryCount(f).reason,'negative-expected-stock');
});
