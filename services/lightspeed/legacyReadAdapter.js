// Opt-in replacement for READ METHODS of services/lightspeedApi.js.
// Preserves existing request paths and response envelopes without touching old routes.
// Write methods are intentionally absent: no consumer can bypass write policy here.
const safe = value => encodeURIComponent(String(value));
export function createLegacyLightspeedReadAdapter({ transport } = {}) {
  if (typeof transport?.request !== 'function') throw new TypeError('Shared transport required.');
  return Object.freeze({
    getSale: saleId => transport.request('/api/2.0/sales/' + safe(saleId)),
    searchSalesByInvoiceNumber: invoice =>
      transport.request('/api/2.0/search?type=sales&invoice_number=' + safe(invoice) + '&page_size=20'),
    searchSalesByCustomer: customerId =>
      transport.request('/api/2.0/search?type=sales&customer_id=' + safe(customerId) + '&page_size=1000'),
    searchSalesByState: state =>
      transport.request('/api/2.0/search?type=sales&state=' + safe(state) + '&page_size=1000'),
    getFulfillmentsForSale: saleId =>
      transport.request('/api/2.0/fulfillments?sale_id=' + safe(saleId)),
    getCustomer: customerId => transport.request('/api/2.0/customers/' + safe(customerId)),
    getProduct: productId => transport.request('/api/2.0/products/' + safe(productId)),
    getStoreCredit: customerId => transport.request('/api/2026-07/store_credits/' + safe(customerId))
  });
}
