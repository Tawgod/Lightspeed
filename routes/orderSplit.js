import express from 'express';
import { createLightspeedClient } from '../services/lightspeedApi.js';

function unwrapData(payload) {
  if (payload && Object.prototype.hasOwnProperty.call(payload, 'data')) {
    return payload.data;
  }
  return payload;
}

function amountFromPayment(payment) {
  const candidates = [
    payment?.amount,
    payment?.amount_including_tax,
    payment?.payment_amount
  ];

  for (const value of candidates) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }

  return 0;
}

export function createOrderSplitRouter({ domain, token }) {
  const router = express.Router();

  async function resolveSaleId(client, saleRef) {
    // Lightspeed's public-facing sale number/invoice number is not the sale UUID.
    // Accept either form so staff can enter values such as "12".
    const looksLikeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(saleRef);
    if (looksLikeUuid) return { saleId: saleRef, matchedBy: 'id' };

    const searchPayload = await client.searchSalesByInvoiceNumber(saleRef);
    const results = unwrapData(searchPayload) || [];
    const sales = Array.isArray(results)
      ? results
      : (results.sales || results.results || []);

    if (!Array.isArray(sales) || sales.length === 0) {
      const error = new Error(`No Lightspeed sale found for invoice/sale number "${saleRef}".`);
      error.status = 404;
      throw error;
    }

    const exact = sales.find(s => String(s.invoice_number ?? s.invoiceNumber ?? '') === String(saleRef));
    const match = exact || sales[0];
    if (!match?.id) {
      const error = new Error('Lightspeed search returned a sale without an ID.');
      error.status = 502;
      error.details = match || searchPayload;
      throw error;
    }

    return { saleId: match.id, matchedBy: 'invoice_number', matchedSale: match };
  }

  // Read-only proof of concept. This route does not modify a sale,
  // fulfillment, payment, or customer balance.
  router.get('/sales/:saleId/inspect', async (req, res) => {
    try {
      const client = createLightspeedClient({ domain, token });
      const saleRef = req.params.saleId;
      const resolved = await resolveSaleId(client, saleRef);
      const saleId = resolved.saleId;

      const [salePayload, fulfillmentPayload] = await Promise.all([
        client.getSale(saleId),
        client.getFulfillmentsForSale(saleId)
      ]);

      const sale = unwrapData(salePayload) || {};
      const fulfillments = unwrapData(fulfillmentPayload) || [];
      const payments = sale.payments || sale.register_sale_payments || [];
      const lineItems = sale.line_items || sale.register_sale_products || [];

      let customer = null;
      let storeCredit = null;
      let storeCreditStatus = 'not_checked';

      if (sale.customer_id) {
        try {
          customer = unwrapData(await client.getCustomer(sale.customer_id));
        } catch (error) {
          customer = { error: error.message, status: error.status || 500 };
        }

        try {
          storeCredit = unwrapData(await client.getStoreCredit(sale.customer_id));
          storeCreditStatus = 'available';
        } catch (error) {
          storeCreditStatus = error.status === 403 ? 'scope_missing' : 'unavailable';
          storeCredit = {
            error: error.message,
            status: error.status || 500,
            details: error.details || null
          };
        }
      }

      const totalPayments = payments.reduce((sum, payment) => sum + amountFromPayment(payment), 0);
      const state = String(sale.state || sale.status || '').toLowerCase();
      const blockedStates = new Set(['closed', 'voided', 'completed', 'return']);

      res.json({
        readOnly: true,
        requestedSaleRef: saleRef,
        saleId,
        matchedBy: resolved.matchedBy,
        eligibleForSplitPreview: Boolean(
          sale.id &&
          sale.customer_id &&
          lineItems.length > 0 &&
          !blockedStates.has(state)
        ),
        blockers: [
          ...(!sale.customer_id ? ['Sale has no customer attached.'] : []),
          ...(lineItems.length === 0 ? ['Sale has no line items.'] : []),
          ...(blockedStates.has(state) ? [`Sale state "${state}" is blocked from splitting.`] : [])
        ],
        sale: {
          id: sale.id || saleId,
          state: sale.state || null,
          status: sale.status || null,
          invoiceNumber: sale.invoice_number || null,
          customerId: sale.customer_id || null,
          total: sale.total_price || sale.total || null,
          balance: sale.balance || null,
          paymentsTotal: totalPayments,
          payments,
          lineItems
        },
        customer,
        fulfillment: {
          count: Array.isArray(fulfillments) ? fulfillments.length : 0,
          records: Array.isArray(fulfillments) ? fulfillments : []
        },
        depositPlan: {
          proposedAction: totalPayments > 0
            ? 'Convert the full existing payment/deposit into customer store credit before executing a split.'
            : 'No existing payment/deposit detected.',
          detectedPaymentAmount: totalPayments,
          storeCreditStatus,
          currentStoreCredit: storeCredit
        }
      });
    } catch (error) {
      console.error('Order split inspection failed:', error);
      res.status(error.status || 500).json({
        error: error.message,
        details: error.details || null,
        readOnly: true
      });
    }
  });

  return router;
}
