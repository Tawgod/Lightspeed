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
      const [primary, secondary] = await Promise.all(paths.map(path => readLightspeedCollection({transport,path})));
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
