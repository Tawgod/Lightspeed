// Canonical read-only Sales contract. Sale mutations remain protected future work.
const id = value => encodeURIComponent(String(value));
const nonempty = value => {
  if (value === null || value === undefined || String(value).trim() === '') throw new TypeError('Sale search identifier required.');
  return String(value);
};
export function createLightspeedSalesRead({ transport } = {}) {
  if (typeof transport?.request !== 'function') throw new TypeError('Lightspeed transport required.');
  return Object.freeze({
    get: saleId => transport.request('/api/2.0/sales/' + id(nonempty(saleId))),
    byInvoice: invoice => transport.request('/api/2.0/search?type=sales&invoice_number=' + id(nonempty(invoice)) + '&page_size=20'),
    byCustomer: customerId => transport.request('/api/2.0/search?type=sales&customer_id=' + id(nonempty(customerId)) + '&page_size=1000'),
    byState: state => transport.request('/api/2.0/search?type=sales&state=' + id(nonempty(state)) + '&page_size=1000')
  });
}
