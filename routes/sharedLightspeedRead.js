import express from 'express';
import { employeeRequestPrincipal } from '../services/lightspeed/staffAdapter.js';

// Not mounted by server.js until existing staff permissions and test tenant are validated.
// Feature-facing routes retain ownership of workflow/local enrichment; this is a read gateway.
export function createSharedLightspeedReadRouter({
  policy, customers, products, inventory, purchaseOrders, sales, fulfillments, storeCredit,
  environment = 'production'
} = {}) {
  if (typeof policy?.authorize !== 'function' || !['production','test'].includes(environment)) {
    throw new TypeError('A verified shared policy and trusted environment are required.');
  }
  const api = { customers, products, inventory, purchaseOrders, sales, fulfillments, storeCredit };
  const router = express.Router();
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const invalid = () => Object.assign(new Error('Invalid search or identifier.'), { status: 400 });
  const query = value => {
    const q = typeof value === 'string' ? value.trim() : '';
    if (!q || q.length > 150) throw invalid();
    return q;
  };
  const id = value => {
    const text = String(value ?? '');
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(text)) throw invalid();
    return text;
  };
  function read(operation, serviceName, method, input, project = x => x) {
    return async (req, res) => {
      try {
        // Authorize BEFORE looking up user-controlled or sensitive backend data.
        await policy.authorize({
          principal: employeeRequestPrincipal(req),
          operation, mode: 'read', environment
        });
        const service = api[serviceName];
        if (typeof service?.[method] !== 'function') {
          const e = new Error('Read service unavailable.'); e.status = 503; throw e;
        }
        const data = await service[method](input(req));
        res.json({ data: project(data), readOnly: true });
      } catch (error) {
        const status = [400, 401, 403, 404, 409, 503].includes(error?.status) ? error.status : 502;
        // Do not echo raw vendor errors or PII to HTTP clients.
        const msg = status === 400 ? 'Invalid read identifier.' :
          status === 401 || status === 403 ? 'Employee permission required.' :
          status === 404 ? 'Record not found.' : status === 409 ? 'Ambiguous record.' :
          'Shared read service unavailable.';
        res.status(status).json({ error: msg });
      }
    };
  }
  router.get('/customers/search', read('customers.search', 'customers', 'search', req => query(req.query.q)));
  router.get('/products/exact', read('products.exact', 'products', 'exact', req => query(req.query.q)));
  router.get('/inventory/products/:id', read('inventory.read', 'inventory', 'byProduct', req => id(req.params.id)));
  router.get('/purchase-orders/:id', read('purchaseOrders.read', 'purchaseOrders', 'get', req => id(req.params.id),
    po => ({ ...po, raw: undefined, lines: po.lines?.map(({ raw, ...line }) => line) || [] })));
  router.get('/sales/:id', read('sales.read', 'sales', 'get', req => id(req.params.id)));
  router.get('/fulfillments/sales/:id', read('fulfillments.read', 'fulfillments', 'forSale', req => id(req.params.id),
    records => records.map(({ raw, ...record }) => record)));
  router.get('/store-credit/customers/:id', read('storeCredit.read', 'storeCredit', 'get', req => id(req.params.id)));
  return router;
}
