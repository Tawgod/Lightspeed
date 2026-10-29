import { requireLightspeedRows } from './readCollection.js';

// Does not change the public legacy envelope. This is an opt-in domain read model.
export function createLightspeedFulfillmentsRead({ transport } = {}) {
  if (typeof transport?.request !== 'function') throw new TypeError('Lightspeed transport required.');
  return Object.freeze({
    async forSale(saleId) {
      if (saleId === null || saleId === undefined || !String(saleId).trim()) throw new TypeError('Sale ID required.');
      const rows = requireLightspeedRows(await transport.request(
        '/api/2.0/fulfillments?sale_id=' + encodeURIComponent(String(saleId))
      ));
      return rows.map(row => ({
        id: row?.id == null ? null : String(row.id),
        saleId: String(row?.sale_id || row?.sale?.id || saleId),
        state: row?.status ?? row?.state ?? null,
        raw: row
      }));
    }
  });
}
