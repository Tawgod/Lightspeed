import { readLightspeedCollection, LightspeedIncompleteReadError } from './readCollection.js';

// One canonical read-only PO supplier/line-item contract for Ordering, PO Companion and Labels.
// The legacy PO Companion workflow retains local supplier/product mapping and review state.
const idValid = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(v);
const string = v => v == null ? '' : String(v);
const quantity = v => {
  if (v == null || v === '') return null; // missing is NOT zero
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
export function normalizeLightspeedPurchaseOrder(po, lines = []) {
  if (!po?.id || !Array.isArray(lines)) throw new LightspeedIncompleteReadError('PO identity/lines unavailable.');
  const supplier = po.supplier || {};
  return {
    id: string(po.id), status: po.status ?? null,
    supplier: { id: string(po.supplier_id || supplier.id) || null, name: supplier.name ?? null },
    lines: lines.map((line, index) => ({
      id: string(line?.id || ('line-' + index)),
      productId: string(line?.product_id || line?.product?.id || line?.product?.product_id) || null,
      productName: string(line?.product?.name || line?.name),
      quantity: quantity(line?.quantity ?? line?.quantity_ordered ?? line?.count),
      supplierSku: string(line?.supplier_sku ?? line?.supplier_code ?? line?.product?.supplier_code),
      sku: string(line?.sku ?? line?.product?.sku),
      upc: string(line?.upc ?? line?.product?.upc),
      raw: line
    })),
    raw: po
  };
}
export function createLightspeedPurchaseOrdersRead({ transport } = {}) {
  if (typeof transport?.request !== 'function') throw new TypeError('Lightspeed transport required.');
  const list = () => readLightspeedCollection({
    transport, path: '/api/2026-04/purchase_orders?page_size=1000'
  });
  async function get(poId) {
    const id = String(poId || '').trim();
    if (!idValid(id)) throw new TypeError('Invalid purchase order ID.');
    // PO Companion currently validates membership in the list; don't assume an
    // undocumented direct-get endpoint exists.
    const matches = (await list()).filter(row => String(row?.id) === id);
    if (matches.length > 1) throw new LightspeedIncompleteReadError('Duplicate purchase order identifiers.');
    if (!matches.length) {
      const error = new Error('Purchase order not found.');
      error.status = 404; error.code = 'LIGHTSPEED_PO_NOT_FOUND';
      throw error;
    }
    const lines = await readLightspeedCollection({
      transport, path: '/api/2026-04/purchase_orders/' + encodeURIComponent(id) + '/line_items?page_size=1000'
    });
    return normalizeLightspeedPurchaseOrder(matches[0], lines);
  }
  return Object.freeze({ list, get });
}
