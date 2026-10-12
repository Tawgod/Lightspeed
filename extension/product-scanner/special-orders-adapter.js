// Converts supplier captures to the existing special-orders matching contract.
// This module contains no credentials and performs no writes.
export function toSpecialOrderMatchRequest(product = {}, supplierId = null) {
  const clean = v => typeof v === 'string' ? v.trim() : '';
  const upc = clean(product.upc).replace(/[^0-9]/g, '');
  return {
    product_code: upc || clean(product.sku),
    sku: clean(product.sku),
    supplier_sku: clean(product.supplierSku),
    name: clean(product.name),
    description: clean(product.description),
    ...(supplierId ? { supplier_id: supplierId } : {})
  };
}

export function normalizeMatches(local = [], remote = []) {
  const entries = [];
  const byKey = new Map();
  for (const [source, rows] of [['railway', local], ['lightspeed', remote]]) {
    for (const row of rows) {
      const id = row.lightspeed_product_id || (source === 'lightspeed' ? row.id : null);
      const key = id ? 'ls:' + String(id) : 'local:' + String(row.local_id ?? row.id);
      if (byKey.has(key)) {
        const existing = byKey.get(key);
        existing.sources.push(source);
        existing.score = Math.max(existing.score || 0, Number(row.score) || 0);
        continue;
      }
      const match = {
        key, lightspeedId: id || null,
        localId: row.local_id || (source === 'railway' ? row.id : null),
        name: row.name || '', sku: row.sku || '', upc: row.upc || '',
        description: row.description || '', brand: row.brand || '',
        score: Number(row.score) || 0,
        reasons: Array.isArray(row.reasons) ? row.reasons : [],
        sources: [source]
      };
      byKey.set(key, match); entries.push(match);
    }
  }
  return entries.sort((a,b)=>b.score-a.score || a.name.localeCompare(b.name));
}

// No result from one service must never be treated as confirmation that a
// product is absent from Lightspeed. Both checks must succeed.
export async function checkProductMatches(product, lookup) {
  const request = toSpecialOrderMatchRequest(product);
  if (!request.product_code && !request.sku && !request.name) {
    throw new Error('Enter a barcode, SKU, or product name before checking duplicates.');
  }
  const [local, remote] = await Promise.all([
    lookup('local', request), lookup('remote', request)
  ]);
  if (!Array.isArray(local?.matches) || !Array.isArray(remote?.matches)) {
    throw new Error('Duplicate checks returned an unexpected response.');
  }
  return { verified: true, matches: normalizeMatches(local.matches, remote.matches) };
}
