import express from 'express';
import { createLightspeedClient } from '../services/lightspeedApi.js';

const unwrap = (x) => x && Object.prototype.hasOwnProperty.call(x, 'data') ? x.data : x;

export function createWorkOrderCombineRouter({ domain, token }) {
  const router = express.Router();

  async function resolveSale(client, ref) {
    if (/^[0-9a-f-]{36}$/i.test(ref)) {
      return unwrap(await client.getSale(ref)) || {};
    }
    const found = unwrap(await client.searchSalesByInvoiceNumber(ref)) || [];
    const rows = Array.isArray(found) ? found : (found.sales || found.results || []);
    const match = rows.find(s => String(s.invoice_number) === String(ref)) || rows[0];
    if (!match?.id) {
      const e = new Error('Sale not found.');
      e.status = 404;
      throw e;
    }
    return unwrap(await client.getSale(match.id)) || match;
  }

  function paymentTotal(sale) {
    return (sale.payments || sale.register_sale_payments || [])
      .reduce((sum, p) => sum + Number(p.amount || 0), 0);
  }

  function saleSummary(sale) {
    const lines = sale.line_items || sale.register_sale_products || [];
    return {
      id: sale.id,
      invoiceNumber: sale.invoice_number || null,
      state: sale.state || null,
      status: sale.status || null,
      attributes: Array.isArray(sale.attributes) ? sale.attributes : [],
      date: sale.date || sale.sale_date || null,
      total: Number(sale.total_price ?? sale.total ?? 0),
      paymentTotal: paymentTotal(sale),
      lineCount: lines.length,
      quantityTotal: lines.reduce((sum, line) => sum + Number(line.quantity || 0), 0),
      lineItems: lines
    };
  }

  router.get('/eligible', async (req, res) => {
    try {
      const client = createLightspeedClient({ domain, token });
      const [pendingSearch, parkedSearch] = await Promise.all([
        client.searchSalesByState('pending'),
        client.searchSalesByState('parked')
      ]);

      const normalizeRows = (payload) => {
        const data = unwrap(payload) || [];
        return Array.isArray(data) ? data : (data.sales || data.results || []);
      };

      const deduped = new Map();
      for (const row of [...normalizeRows(pendingSearch), ...normalizeRows(parkedSearch)]) {
        if (row?.id) deduped.set(row.id, row);
      }

      const customerIds = [...new Set(
        [...deduped.values()].map(sale => sale.customer_id).filter(Boolean)
      )];

      const customerEntries = await Promise.all(customerIds.map(async customerId => {
        try {
          const customer = unwrap(await client.getCustomer(customerId)) || {};
          const name = [customer.first_name, customer.last_name].filter(Boolean).join(' ').trim()
            || customer.company_name
            || 'Customer';
          return [customerId, { name, company: customer.company_name || null }];
        } catch {
          return [customerId, { name: 'Customer', company: null }];
        }
      }));
      const customersById = Object.fromEntries(customerEntries);

      const eligible = [];
      for (const sale of deduped.values()) {
        const state = String(sale.state || '').toLowerCase();
        const lines = sale.line_items || sale.register_sale_products || [];
        if (!sale.customer_id || !['pending','parked'].includes(state) || !lines.length) continue;

        const attrs = Array.isArray(sale.attributes)
          ? sale.attributes
          : (Array.isArray(sale.register_sale_attributes) ? sale.register_sale_attributes : []);

        eligible.push({
          id: sale.id,
          invoiceNumber: sale.invoice_number || null,
          state,
          attributes: attrs,
          customerId: sale.customer_id,
          customerName: customersById[sale.customer_id]?.name || 'Customer',
          company: customersById[sale.customer_id]?.company || null,
          lineCount: lines.length,
          quantityTotal: lines.reduce((sum, line) => sum + Number(line.quantity || 0), 0),
          total: Number(sale.total_price ?? sale.total ?? 0),
          paymentTotal: paymentTotal(sale),
          balance: Number(sale.balance ?? 0),
          date: sale.date || sale.sale_date || sale.created_at || null
        });
      }

      eligible.sort((a, b) => {
        const aTime = a.date ? new Date(a.date).getTime() : 0;
        const bTime = b.date ? new Date(b.date).getTime() : 0;
        return bTime - aTime;
      });

      res.json({
        eligible: true,
        count: eligible.length,
        orders: eligible
      });
    } catch (e) {
      res.status(e.status || 500).json({
        eligible: false,
        error: e.message,
        details: e.details || null
      });
    }
  });

  router.get('/sales/:saleRef/combine-preview', async (req, res) => {
    try {
      const client = createLightspeedClient({ domain, token });
      const current = await resolveSale(client, req.params.saleRef);

      if (!current.customer_id) {
        return res.status(409).json({
          combinable: false,
          error: 'This sale has no customer attached.'
        });
      }

      const customer = unwrap(await client.getCustomer(current.customer_id)) || {};
      const search = unwrap(await client.searchSalesByCustomer(current.customer_id)) || [];
      const rows = Array.isArray(search) ? search : (search.sales || search.results || []);

      const openCandidates = [];
      for (const row of rows) {
        if (!row?.id || row.id === current.id) continue;
        const state = String(row.state || '').toLowerCase();
        if (!['pending', 'parked'].includes(state)) continue;

        const full = unwrap(await client.getSale(row.id)) || row;
        openCandidates.push(saleSummary(full));
      }

      const currentSummary = saleSummary(current);
      const all = [currentSummary, ...openCandidates];

      res.json({
        combinable: all.length > 1,
        customer: {
          id: current.customer_id,
          name: [customer.first_name, customer.last_name].filter(Boolean).join(' ').trim() || customer.company_name || 'Customer',
          company: customer.company_name || null
        },
        currentSale: currentSummary,
        otherOpenWorkOrders: openCandidates,
        combinedPreview: {
          saleCount: all.length,
          lineCount: all.reduce((sum, s) => sum + s.lineCount, 0),
          quantityTotal: all.reduce((sum, s) => sum + s.quantityTotal, 0),
          paymentTotal: all.reduce((sum, s) => sum + s.paymentTotal, 0),
          estimatedSalesTotal: all.reduce((sum, s) => sum + s.total, 0)
        },
        writeEnabled: false,
        note: 'Preview only. No orders were changed.'
      });
    } catch (e) {
      res.status(e.status || 500).json({
        combinable: false,
        error: e.message,
        details: e.details || null
      });
    }
  });

  return router;
}
