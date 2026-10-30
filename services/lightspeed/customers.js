// Read-only remote customer contract extracted from Special Orders search conventions.
// Local profile enrichment remains a feature-owned responsibility until consumer migration.
const unwrap = value => Array.isArray(value) ? value : (Array.isArray(value?.data) ? value.data : []);
export function createLightspeedCustomersRead({ transport } = {}) {
  if (typeof transport?.request !== 'function') throw new TypeError('Shared Lightspeed transport required.');
  return Object.freeze({
    async get(customerId) {
      if (!customerId) throw new TypeError('Customer ID is required.');
      return transport.request('/api/2.0/customers/' + encodeURIComponent(String(customerId)));
    },
    async search(query) {
      const q = String(query || '').trim();
      if (!q) return [];
      const params = new URLSearchParams({ type: 'customers', page_size: '20' });
      if (q.includes('@')) params.set('email', q);
      else if (/^[+()\d\s.-]{7,}$/.test(q)) params.set('phone', q);
      else {
        const parts = q.split(/\s+/).filter(Boolean);
        params.set('first_name', parts[0]);
        if (parts.length > 1) params.set('last_name', parts.slice(1).join(' '));
      }
      const response = await transport.request('/api/2026-04/search?' + params);
      if (!Array.isArray(response) && !Array.isArray(response?.data)) {
        const error = new Error('Customer search response incomplete.');
        error.code = 'LIGHTSPEED_INCOMPLETE_SEARCH';
        throw error;
      }
      return unwrap(response);
    }
  });
}
