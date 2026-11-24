import { LightspeedIncompleteReadError } from './readCollection.js';

// Internal additive projection. Legacy purchaseOrders.get/list and PR #37 remain unchanged.
const fail = message => { throw new LightspeedIncompleteReadError(message); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, field) => {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !value.trim() || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) fail('Invalid ' + field + '.');
  return value;
};
const agree = (field, ...values) => {
  const present = values.map(v => exact(v, field)).filter(v => v !== null);
  if (new Set(present).size > 1) fail('Conflicting ' + field + '.');
  return present[0] ?? null;
};
const qty = value => {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value))) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER ? n : null;
};
const text = value => typeof value === 'string' && value.trim() ? value : null;
const statuses = new Set(['OPEN', 'DISPATCHED', 'RECEIVED', 'CANCELLED', 'CLOSED']);
function header(raw) {
  if (!record(raw)) fail('PO header unavailable.');
  const id = exact(raw.id, 'PO ID');
  if (!id) fail('PO ID unavailable.');
  const supplierId = agree('supplier ID', raw.supplier_id, raw.supplier?.id);
  const outletId = agree('outlet ID', raw.outlet_id, raw.outlet?.id);
  const status = text(raw.status);
  const type = text(raw.type);
  if (type !== null && type !== 'SUPPLIER') fail('Not a supplier PO.');
  return { id, supplier: { id: supplierId, name: text(raw.supplier?.name) }, outletId,
    poType: type, purchasingStatus: statuses.has(status) ? status : 'UNKNOWN', vendorStatus: status,
    reference: text(raw.reference ?? raw.order_number ?? raw.number ?? raw.name) };
}
function lineProjection(line) {
  if (!record(line) || !record(line.raw)) fail('PO line evidence unavailable.');
  const raw = line.raw;
  // No index-derived identity, numeric identifier coercion, or inferred supplier SKU.
  const id = exact(raw.id, 'line ID');
  const productId = agree('product ID', raw.product_id, raw.product?.id, raw.product?.product_id);
  const supplierSku = agree('supplier SKU', raw.supplier_sku, raw.supplier_code);
  const sku = agree('SKU', raw.sku, raw.product?.sku);
  const upc = agree('UPC', raw.upc, raw.product?.upc);
  const quantities = [raw.quantity_ordered, raw.quantity, raw.count, raw.ordered_quantity, raw.order_quantity].filter(v => v != null && v !== '');
  const parsed = quantities.map(qty);
  const orderedQty = parsed.length && parsed.every(v => v !== null && v === parsed[0]) ? parsed[0] : null;
  return { id, productId, productName: text(line.productName), supplierSku, sku, upc, orderedQty,
    // A product-level supplier code may belong to a different supplier. Do not promote it.
    warnings: [!id && 'missing_line_id', !productId && 'missing_product_id', !supplierSku && 'unverified_supplier_sku', orderedQty === null && 'unknown_ordered_qty'].filter(Boolean) };
}
function uniqueIds(rows, label) {
  const seen = new Set();
  for (const row of rows) {
    if (row.id === null) continue;
    if (seen.has(row.id)) fail('Duplicate ' + label + ' ID.');
    seen.add(row.id);
  }
}
const source = readAt => ({ system: 'Lightspeed', apiVersion: '2026-04', readAt, complete: true, snapshotAtomic: false });
export function projectPurchaseOrder(po, readAt) {
  if (!record(po) || !Array.isArray(po.lines)) fail('PO detail unavailable.');
  const result = header(po.raw);
  if (po.id !== result.id || (po.supplier?.id ?? null) !== result.supplier.id) fail('PO projection identity mismatch.');
  const lines = po.lines.map(lineProjection);
  uniqueIds(lines, 'PO line');
  return { ...result, lines, source: source(readAt), receiving: { state: 'UNKNOWN', receivedQty: null, source: null, verifiedAt: null } };
}
export function createPurchasingRead({ purchaseOrders, clock = () => new Date() } = {}) {
  if (typeof purchaseOrders?.get !== 'function' || typeof purchaseOrders?.list !== 'function') throw new TypeError('Existing shared PO reader required.');
  const readAt = () => clock().toISOString();
  async function get(id) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new TypeError('Invalid PO ID.');
    const po = projectPurchaseOrder(await purchaseOrders.get(id), readAt());
    if (po.id !== id) fail('Requested PO identity mismatch.');
    return po;
  }
  async function list(filters = {}) {
    if (!record(filters) || Object.keys(filters).some(k => !['supplierId', 'outletId', 'status'].includes(k))) throw new TypeError('Invalid PO filters.');
    for (const value of Object.values(filters)) if (typeof value !== 'string' || !value.trim() || value.trim() !== value) throw new TypeError('Invalid PO filter.');
    if (filters.status !== undefined && !statuses.has(filters.status) && filters.status !== 'UNKNOWN') throw new TypeError('Invalid PO status filter.');
    const raw = await purchaseOrders.list();
    if (!Array.isArray(raw)) fail('PO list unavailable.');
    const rows = raw.map(header);
    uniqueIds(rows, 'PO');
    const items = rows.filter(row => (filters.supplierId === undefined || row.supplier.id === filters.supplierId) &&
      (filters.outletId === undefined || row.outletId === filters.outletId) && (filters.status === undefined || row.purchasingStatus === filters.status));
    return { items, source: source(readAt()), scannedCount: rows.length,
      unresolvedReferenceCount: rows.filter(row => (filters.supplierId !== undefined && row.supplier.id === null) || (filters.outletId !== undefined && row.outletId === null)).length };
  }
  return Object.freeze({ get, list });
}

// Invoice and shipment inputs are documentary evidence only. No injected writer,
// inventory callback, received status, allocation, or approval execution is exposed.
export function projectInvoiceLineEvidence(input) {
  if (!record(input)) throw new TypeError('Invoice line evidence required.');
  return { invoiceId: exact(input.invoiceId, 'invoice ID'), lineId: exact(input.lineId, 'invoice line ID'),
    supplierId: exact(input.supplierId, 'supplier ID'), invoicedQty: qty(input.invoicedQty),
    documentRef: exact(input.documentRef, 'document reference'), evidenceOnly: true };
}
export function projectShipmentEvidence(input) {
  if (!record(input)) throw new TypeError('Shipment evidence required.');
  return { supplierId: exact(input.supplierId, 'supplier ID'), trackingId: exact(input.trackingId, 'tracking ID'),
    carrier: text(input.carrier), documentRef: exact(input.documentRef, 'document reference'), evidenceOnly: true };
}
