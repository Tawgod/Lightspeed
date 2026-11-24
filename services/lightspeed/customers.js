import { readLightspeedCollection, requireLightspeedRows } from './readCollection.js';

// Shared backend reader. Raw rows contain PII; callers must enforce approved
// operation grants and feature-specific projections. No local profile enrichment.
export function buildCustomerSearchPath(query) {
  const q = String(query || '').trim();
  if (!q) return null;
  const params = new URLSearchParams({ type: 'customers', page_size: '20' });
  if (q.includes('@')) params.set('email', q);
  else if (/^[+()\d\s.-]{7,}$/.test(q)) params.set('phone', q);
  else {
    const parts = q.split(/\s+/).filter(Boolean);
    params.set('first_name', parts[0]);
    if (parts.length > 1) params.set('last_name', parts.slice(1).join(' '));
  }
  return '/api/2026-04/search?' + params;
}

export function createLightspeedCustomersRead({ transport } = {}) {
  if (typeof transport?.request !== 'function') throw new TypeError('Shared Lightspeed transport required.');
  return Object.freeze({
    async get(customerId, { correlationId } = {}) {
      if (!customerId) throw new TypeError('Customer ID is required.');
      return transport.request('/api/2.0/customers/' + encodeURIComponent(String(customerId)), ...(correlationId === undefined ? [] : [{ correlationId }]));
    },
    async search(query, { correlationId } = {}) {
      const path = buildCustomerSearchPath(query);
      if (!path) return [];
      return readLightspeedCollection({ transport, path, correlationId });
    },
    // Compatibility mode for interactive consumers that currently show one page.
    // Never interpret this response as proof of duplicate absence.
    async searchFirstPage(query, { correlationId } = {}) {
      const path = buildCustomerSearchPath(query);
      const rows = path ? requireLightspeedRows(await transport.request(path, ...(correlationId === undefined ? [] : [{ correlationId }])) ) : [];
      return { rows, coverage: path ? 'single-page' : 'not-queried', complete: false };
    }
  });
}
