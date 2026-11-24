// Internal opt-in projections; not an authorization boundary or a public API.
import { LightspeedIncompleteReadError } from './readCollection.js';

const fail = () => { throw new LightspeedIncompleteReadError('Customer/sales evidence incomplete or inconsistent.'); };
const identifier = v => typeof v === 'string' && v.trim() && v === v.trim() ? v : null;
const record = v => v && typeof v === 'object' && !Array.isArray(v);
const unwrap = body => {
  const row = record(body) && Object.hasOwn(body, 'data') ? body.data : body;
  if (!record(row)) fail();
  return row;
};
const text = v => typeof v === 'string' && v.trim() ? v : null;
const email = v => typeof v === 'string' ? v.trim().toLowerCase() : '';
const phone = v => typeof v === 'string' && /^[+()\d .-]+$/.test(v) ? v.replace(/[^\d]/g,'') : '';
const decimal = v => typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? v : null;
const requestedId = v => { const id = identifier(v); if (!id) throw new TypeError('Exact string identifier required.'); return id; };

export function createCustomerSalesEvidence({ customers, sales, fulfillments, storeCredit } = {}) {
  for (const [reader, methods] of [[customers,['get','search']],[sales,['get','byInvoice','byCustomer','byState']],[fulfillments,['forSale']],[storeCredit,['get']]]) {
    if (!methods.every(m => typeof reader?.[m] === 'function')) throw new TypeError('Existing read services required.');
  }
  const projectCustomer = row => {
    if (!record(row) || !identifier(row.id)) fail();
    return { customerId: row.id, source: 'lightspeed', updatedAt: text(row.updated_at) };
  };
  const projectSale = row => {
    if (!record(row) || !identifier(row.id)) fail();
    const direct = identifier(row.customer_id), nested = identifier(row.customer?.id);
    if (direct && nested && direct !== nested) fail();
    return { saleId: row.id, customerId: direct ?? nested, state: text(row.state ?? row.status),
      invoiceNumber: identifier(row.invoice_number), deposit: null, partialPickup: null, returnEvents: null };
  };
  return Object.freeze({
    async customer(id) {
      id = requestedId(id);
      const out = projectCustomer(unwrap(await customers.get(id)));
      if (out.customerId !== id) fail();
      return out;
    },
    async matchContact(kind, query) {
      if (!['email','phone'].includes(kind) || typeof query !== 'string') throw new TypeError('Contact query required.');
      const normalize = kind === 'email' ? email : phone;
      const key = normalize(query);
      if (kind === 'email' ? !/^[^\s@]+@[^\s@]+$/.test(key) : key.length < 7) throw new TypeError('Invalid contact query.');
      const rows = await customers.search(query.trim());
      if (!Array.isArray(rows)) fail();
      const seen = new Set(), matches = [];
      for (const row of rows) {
        const item = projectCustomer(row);
        if (seen.has(item.customerId)) fail();
        seen.add(item.customerId);
        if (normalize(row[kind]) === key) matches.push({...item, evidence: kind});
      }
      return { matches, ambiguous: matches.length > 1, coverage: 'search-candidates-only', requiresReview: true };
    },
    async sale(id) {
      id = requestedId(id);
      const out = projectSale(unwrap(await sales.get(id)));
      if (out.saleId !== id) fail();
      return out;
    },
    async salesPage(kind, query) {
      const methods = {invoice:'byInvoice',customer:'byCustomer',state:'byState'};
      if (!Object.hasOwn(methods,kind)) throw new TypeError('Unsupported sale query.');
      query = requestedId(query);
      const body = await sales[methods[kind]](query);
      const rows = Array.isArray(body) ? body : body?.data;
      if (!Array.isArray(rows)) fail();
      const items = rows.map(projectSale);
      if (new Set(items.map(x=>x.saleId)).size !== items.length) fail();
      if (kind === 'customer' && items.some(x=>x.customerId !== query)) fail();
      if (kind === 'invoice' && items.some(x=>x.invoiceNumber !== query)) fail();
      return { items, coverage:'single-page', complete:false };
    },
    async fulfillmentEvidence(id) {
      id = requestedId(id);
      const rows = await fulfillments.forSale(id);
      if (!Array.isArray(rows)) fail();
      const items = rows.map(row => {
        if (!record(row) || !identifier(row.id) || row.saleId !== id) fail();
        const explicit = identifier(row.raw?.sale_id) ?? identifier(row.raw?.sale?.id);
        if (explicit && explicit !== id) fail();
        return { fulfillmentId:row.id, saleId:id, state:text(row.state), association:explicit === id ? 'source-confirmed':'request-scoped', pickedUpQuantity:null };
      });
      if (new Set(items.map(x=>x.fulfillmentId)).size !== items.length) fail();
      return { items, coverage:'single-page', complete:false };
    },
    async creditEvidence(id) {
      id = requestedId(id);
      const row = unwrap(await storeCredit.get(id));
      if (row.customer_id != null && row.customer_id !== id) fail();
      return { customerId:id, amount:decimal(row.amount), currency:text(row.currency), updatedAt:text(row.updated_at), coverage:'balance-only', transactions:null };
    }
  });
}
