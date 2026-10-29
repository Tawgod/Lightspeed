// Read-only store credit. All credit writes must use guarded mutation pipeline.
export function createLightspeedStoreCreditRead({ transport } = {}) {
  if (typeof transport?.request !== 'function') throw new TypeError('Lightspeed transport required.');
  return Object.freeze({
    get: customerId => {
      if (!customerId || !String(customerId).trim()) throw new TypeError('Customer ID required.');
      return transport.request('/api/2026-07/store_credits/' + encodeURIComponent(String(customerId)));
    }
  });
}
