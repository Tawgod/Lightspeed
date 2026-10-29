// Read-only inventory: Lightspeed remains the authoritative quantity source.
// Do not synthesize zero quantities when the vendor response is incomplete.
export function createLightspeedInventoryRead({ transport } = {}) {
  if (typeof transport?.request !== 'function') throw new TypeError('Lightspeed transport required.');
  return Object.freeze({
    async byProduct(productId) {
      if (!productId || !String(productId).trim()) throw new TypeError('Product ID required.');
      const response = await transport.request('/api/2026-04/inventory/' + encodeURIComponent(String(productId)));
      const data = Object.hasOwn(response || {}, 'data') ? response.data : response;
      if (!data || typeof data !== 'object') {
        const err = new Error('Inventory read response incomplete.');
        err.code = 'LIGHTSPEED_INCOMPLETE_READ';
        err.status = 502;
        throw err;
      }
      return data; // retain exact outlet and stock representations for consumers
    }
  });
}
