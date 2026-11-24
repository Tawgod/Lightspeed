import { readLightspeedCollection, LightspeedIncompleteReadError } from './readCollection.js';

// Non-mutating remote product identity reads. No "first result" fallback.
const codes = product => [
  product?.sku, product?.upc, product?.supplier_code,
  ...(Array.isArray(product?.product_codes) ? product.product_codes.map(x => x?.code ?? x?.value) : [])
].filter(x => x !== null && x !== undefined && String(x).trim() !== '');
const normalized = v => String(v).trim().toLowerCase();
export function findExactLightspeedProducts(query, products) {
  const q = normalized(query);
  if (!q || !Array.isArray(products)) return [];
  const numericCode = /^[0-9\s()-]+$/.test(String(query));
  const digits = numericCode ? String(query).replace(/\D/g, '') : '';
  return products.filter(product =>
    codes(product).some(value => normalized(value) === q ||
      (digits.length >= 6 && /^[0-9\s()-]+$/.test(String(value)) &&
       String(value).replace(/\D/g,'') === digits)));
}
export function createLightspeedProductsRead({ transport } = {}) {
  if (typeof transport?.request !== 'function') throw new TypeError('Lightspeed transport required.');
  return Object.freeze({
    get: productId => {
      if (!productId || !String(productId).trim()) throw new TypeError('Product ID required.');
      return transport.request('/api/2.0/products/' + encodeURIComponent(String(productId)));
    },
    async exact(identifier) {
      const q = String(identifier ?? '').trim();
      if (!q) throw new TypeError('Identifier required.');
      const paths = [
        '/api/2026-07/products?sku=' + encodeURIComponent(q.toLowerCase()) + '&page_size=1000',
        '/api/2026-07/search?type=products&sku=' + encodeURIComponent(q.toLowerCase()) + '&page_size=20'
      ];
      const [primary, secondary] = await Promise.all(paths.map((path, index) =>
        readLightspeedCollection({ transport, path, pagination: index === 0 ? 'single' : 'offset' })));
      // The SKU filter ignores other list parameters per Lightspeed documentation;
      // exhaustive duplicate checks rely on the independent offset-paginated search.
      const found = new Map();
      for (const p of findExactLightspeedProducts(q, [...primary, ...secondary])) {
        if (!p?.id) throw new LightspeedIncompleteReadError('Matched product missing remote ID.');
        if (!found.has(String(p.id))) found.set(String(p.id), p);
      }
      const matches = [...found.values()];
      if (matches.length > 1) {
        const err = new Error('Multiple Lightspeed products share this identifier.');
        err.status = 409; err.code = 'LIGHTSPEED_AMBIGUOUS_IDENTITY'; err.matches = matches.map(p => String(p.id));
        throw err;
      }
      return matches[0] || null;
    }
  });
}

// Offline evidence contract. Coverage must be established by the trusted reader,
// not inferred from a short vendor response or a caller's search criteria.
// Legacy exact() and fuzzy scoring are intentionally unchanged.
export function inspectProductIdentity(identifier, rows, { complete = false } = {}) {
  if (typeof identifier !== 'string' || !identifier.trim() || identifier.length > 256)
    throw new TypeError('Nonempty exact identifier string required.');
  if (!Array.isArray(rows)) throw new TypeError('Product rows required.');
  const matches = new Map();
  let valid = true;
  for (const row of rows) {
    if (!row || typeof row.id !== 'string' || !row.id.trim()) { valid = false; continue; }
    const values = codes(row);
    if (values.some(value => typeof value !== 'string')) valid = false;
    // Keep compatibility candidates visible, but only literal equality is exact.
    if (!findExactLightspeedProducts(identifier, [row]).length &&
        !values.includes(identifier)) continue;
    const evidence = values.filter(value => typeof value === 'string' && value === identifier);
    const prior = matches.get(row.id);
    const active = typeof row.active === 'boolean' ? row.active : null;
    if (prior && prior.active !== active) valid = false;
    matches.set(row.id, {
      id: row.id, active: prior && prior.active !== active ? null : active,
      exact: Boolean(prior?.exact || evidence.length),
      identifiers: [...new Set([...(prior?.identifiers || []), ...evidence])]
    });
  }
  const candidates = [...matches.values()];
  const coverage = complete === true && valid;
  // An inactive match is still a collision; never filter it out.
  const status = candidates.length > 1 ? 'AMBIGUOUS' :
    !coverage ? 'INCOMPLETE' : !candidates.length ? 'NO_MATCH' :
    candidates[0].exact ? 'EXACT_UNIQUE' : 'CANDIDATES';
  return { status, complete: coverage, candidates };
}
