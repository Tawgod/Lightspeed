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
      const currentSaleLineIds = new Set(lineItems.map(line => line.id).filter(Boolean));
      const fulfillmentList = Array.isArray(fulfillments) ? fulfillments : [];
      const orphanedFulfillmentLines = [];
      for (const fulfillment of fulfillmentList) {
        for (const fLine of (fulfillment.line_items || [])) {
          if (fLine.sale_line_item_id && !currentSaleLineIds.has(fLine.sale_line_item_id)) {
            orphanedFulfillmentLines.push({
              fulfillmentId: fulfillment.id,
              saleLineItemId: fLine.sale_line_item_id,
              productId: fLine.product_id || null,
              quantity: fLine.quantity ?? null,
              pickedQuantity: fLine.picked_quantity ?? null,
              packedQuantity: fLine.packed_quantity ?? null,
              fulfilledQuantity: fLine.fulfilled_quantity ?? null
            });
          }
        }
      }

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
          count: fulfillmentList.length,
          records: fulfillmentList,
          integrity: {
            orphanedLineCount: orphanedFulfillmentLines.length,
            orphanedLines: orphanedFulfillmentLines,
            consistentWithCurrentSaleLines: orphanedFulfillmentLines.length === 0
          }
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



  // Simple browser test harness for the controlled parked-sale copy endpoint.
  router.get('/sales/:saleId/test', async (req, res) => {
    try {
      const client = createLightspeedClient({ domain, token });
      const saleRef = req.params.saleId;
      const resolved = await resolveSaleId(client, saleRef);
      const sale = unwrapData(await client.getSale(resolved.saleId)) || {};
      const lines = sale.line_items || [];

      const rows = lines.map((line) => {
        const price = line.unit_price ?? line.price ?? 0;
        const qty = Number(line.quantity || 1);
        return `
          <tr>
            <td style="padding:8px;border-bottom:1px solid #ddd;"><input type="checkbox" class="split-select" data-line-id="${line.id}"></td>
            <td style="padding:8px;border-bottom:1px solid #ddd;">${line.id}</td>
            <td style="padding:8px;border-bottom:1px solid #ddd;">${line.product_id}</td>
            <td style="padding:8px;border-bottom:1px solid #ddd;">${qty}</td>
            <td style="padding:8px;border-bottom:1px solid #ddd;"><input type="number" min="1" max="${qty}" value="1" class="split-qty" data-line-id="${line.id}" style="width:70px;padding:4px;"></td>
            <td style="padding:8px;border-bottom:1px solid #ddd;">$${Number(price).toFixed(2)}</td>
            <td style="padding:8px;border-bottom:1px solid #ddd;">
              <button onclick="createCopy('${line.id}', ${qty})">Create parked copy</button>
              <button style="margin-left:6px;" onclick="removeOriginal('${line.id}')">Remove from original</button>
            </td>
          </tr>`;
      }).join('');

      res.type('html').send(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>Order Split Test</title></head>
<body style="font-family:Arial,sans-serif;max-width:1100px;margin:30px auto;padding:0 20px;">
<h1>Order Split Test — Sale ${sale.invoice_number || saleRef}</h1>
<p><strong>Original sale is not modified by this test.</strong></p>
<table style="border-collapse:collapse;width:100%;">
<thead><tr><th>Select</th><th>Line ID</th><th>Product ID</th><th>Qty</th><th>Split Qty</th><th>Price</th><th>Action</th></tr></thead>
<tbody>${rows}</tbody>
</table>
<button id="split-selected-btn" onclick="splitSelected()" style="margin-top:16px;padding:10px 16px;font-weight:bold;">Split selected items</button>
<button onclick="repairPickup()" style="margin-top:16px;margin-left:8px;padding:10px 16px;">Repair pickup metadata</button>
<button id="convert-deposit-btn" onclick="convertDeposit()" style="margin-top:16px;margin-left:8px;padding:10px 16px;">Convert deposit to store credit</button>
<pre id="result" style="margin-top:20px;background:#f5f5f5;padding:15px;white-space:pre-wrap;"></pre>
<script>
async function convertDeposit() {
  if (!confirm('Remove all current payments from this sale and issue the same total as customer store credit?')) return;
  const out = document.getElementById('result');
  const btn = document.getElementById('convert-deposit-btn');
  btn.disabled = true;
  out.textContent = 'Converting deposit to store credit...';
  try {
    const response = await fetch('/api/order-split/sales/${encodeURIComponent(saleRef)}/convert-deposit', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({})
    });
    const data = await response.json();
    out.textContent = JSON.stringify(data, null, 2);
  } catch (error) {
    out.textContent = String(error);
  } finally {
    btn.disabled = false;
  }
}

async function repairPickup() {
  if (!confirm('Restore the pickup attribute on this sale while preserving its current lines?')) return;
  const out = document.getElementById('result');
  out.textContent = 'Repairing pickup metadata...';
  try {
    const response = await fetch('/api/order-split/sales/${encodeURIComponent(saleRef)}/repair-pickup', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({})
    });
    const data = await response.json();
    out.textContent = JSON.stringify(data, null, 2);
  } catch (error) {
    out.textContent = String(error);
  }
}

async function splitSelected() {
  const selected = [...document.querySelectorAll('.split-select:checked')];
  if (!selected.length) {
    alert('Select at least one item to split.');
    return;
  }
  const items = selected.map(box => {
    const lineItemId = box.dataset.lineId;
    const qtyInput = document.querySelector('.split-qty[data-line-id="' + lineItemId + '"]');
    return { lineItemId, quantity: parseInt(qtyInput?.value || '1', 10) };
  });
  if (!confirm('Create a new parked sale for the selected items and remove them from the original sale?')) return;
  const out = document.getElementById('result');
  const btn = document.getElementById('split-selected-btn');
  btn.disabled = true;
  out.textContent = 'Running combined split...';
  try {
    const response = await fetch('/api/order-split/sales/${encodeURIComponent(saleRef)}/split', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ items })
    });
    const data = await response.json();
    out.textContent = JSON.stringify(data, null, 2);
  } catch (error) {
    out.textContent = String(error);
  } finally {
    btn.disabled = false;
  }
}

async function removeOriginal(lineItemId) {
  if (!confirm('REMOVE this line from the ORIGINAL sale? Use this only after a parked copy has been created.')) return;
  const out = document.getElementById('result');
  out.textContent = 'Updating original sale...';
  try {
    const response = await fetch('/api/order-split/sales/${encodeURIComponent(saleRef)}/remove-from-original', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ lineItemId })
    });
    const data = await response.json();
    out.textContent = JSON.stringify(data, null, 2);
  } catch (error) {
    out.textContent = String(error);
  }
}

async function createCopy(lineItemId, quantity) {
  if (!confirm('Create a NEW parked test sale from this line? The original sale will remain unchanged.')) return;
  const out = document.getElementById('result');
  out.textContent = 'Creating parked test sale...';
  try {
    const response = await fetch('/api/order-split/sales/${encodeURIComponent(saleRef)}/create-test-copy', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ lineItemId, quantity: 1 })
    });
    const data = await response.json();
    out.textContent = JSON.stringify(data, null, 2);
  } catch (error) {
    out.textContent = String(error);
  }
}
</script>
</body></html>`);
    } catch (error) {
      res.status(error.status || 500).send(`Unable to load split test page: ${error.message}`);
    }
  });

  // Controlled write test: create a NEW parked sale from selected quantities.
  // The original sale is never updated by this endpoint.
  router.post('/sales/:saleId/create-test-copy', async (req, res) => {
    try {
      const client = createLightspeedClient({ domain, token });
      const saleRef = req.params.saleId;
      const { lineItemId, quantity = 1 } = req.body || {};

      if (!lineItemId) {
        return res.status(400).json({ error: 'lineItemId is required.' });
      }

      const requestedQty = Number(quantity);
      if (!Number.isFinite(requestedQty) || requestedQty <= 0) {
        return res.status(400).json({ error: 'quantity must be greater than zero.' });
      }

      const resolved = await resolveSaleId(client, saleRef);
      const original = unwrapData(await client.getSale(resolved.saleId)) || {};
      const originalLines = original.line_items || [];
      const selected = originalLines.find(line => line.id === lineItemId);

      if (!selected) {
        return res.status(404).json({ error: 'Selected line item was not found on the original sale.' });
      }

      const availableQty = Number(selected.quantity || 0);
      if (requestedQty > availableQty) {
        return res.status(400).json({
          error: 'Requested quantity exceeds the quantity on the original line.',
          requestedQty,
          availableQty
        });
      }

      if (!original.customer_id) {
        return res.status(400).json({ error: 'Original sale must have a customer before it can be split.' });
      }

      const state = String(original.state || '').toLowerCase();
      if (['closed', 'voided'].includes(state)) {
        return res.status(409).json({ error: `Original sale state "${state}" cannot be used for this test.` });
      }

      const source = original.source || {};
      const authorId =
        source.author_id ||
        original.user_id ||
        original.salesperson_id;

      if (!authorId) {
        return res.status(422).json({
          error: 'Could not determine the source author/cashier ID required to create the parked sale.',
          hint: 'Inspect the original sale source/user fields before retrying.'
        });
      }

      const payload = {
        source: {
          author_id: authorId,
          ...(source.register_id || original.register_id
            ? { register_id: source.register_id || original.register_id }
            : {}),
          type: 'HobbyCornerOrderSplitPOC'
        },
        state: 'parked',
        customer_id: original.customer_id,
        note: `TEST SPLIT from sale ${original.invoice_number || resolved.saleId}. Original sale unchanged.`,
        line_items: [
          {
            product: { id: selected.product_id },
            quantity: requestedQty,
            pricing: {
              price: String(selected.unit_price ?? selected.price ?? 0)
            },
            tax: {
              id: selected.tax_id,
              amount: String((selected.unit_tax ?? selected.tax ?? 0) * requestedQty)
            }
          }
        ]
      };

      const createdPayload = await client.createSale(payload);
      const created = unwrapData(createdPayload) || createdPayload;

      res.status(201).json({
        created: true,
        originalSaleId: resolved.saleId,
        originalInvoiceNumber: original.invoice_number || null,
        originalSaleModified: false,
        selectedLineItemId: lineItemId,
        quantity: requestedQty,
        newSale: created
      });
    } catch (error) {
      console.error('Test split copy failed:', error);
      res.status(error.status || 500).json({
        error: error.message,
        details: error.details || null,
        originalSaleModified: false
      });
    }
  });


  // Controlled write test: remove one selected line from the ORIGINAL sale by
  // resubmitting all remaining lines. This endpoint never touches the copied sale.
  router.post('/sales/:saleId/remove-from-original', async (req, res) => {
    try {
      const client = createLightspeedClient({ domain, token });
      const saleRef = req.params.saleId;
      const { lineItemId } = req.body || {};

      if (!lineItemId) {
        return res.status(400).json({ error: 'lineItemId is required.' });
      }

      const resolved = await resolveSaleId(client, saleRef);
      const original = unwrapData(await client.getSale(resolved.saleId)) || {};
      const originalLines = original.line_items || [];
      const selected = originalLines.find(line => line.id === lineItemId);

      if (!selected) {
        return res.status(404).json({ error: 'Selected line item was not found on the original sale.' });
      }

      const remainingLines = originalLines.filter(line => line.id !== lineItemId);
      if (remainingLines.length === 0) {
        return res.status(409).json({ error: 'Refusing to remove the final line item from the original sale.' });
      }

      const state = String(original.state || '').toLowerCase();
      if (['closed', 'voided'].includes(state)) {
        return res.status(409).json({ error: `Original sale state "${state}" cannot be changed by this test.` });
      }

      const source = original.source || {};
      const authorId = source.author?.id || source.author_id || original.user_id || original.salesperson_id;
      const registerId = source.register_id || original.register_id;

      if (!authorId) {
        return res.status(422).json({ error: 'Could not determine source author/cashier ID.' });
      }

      const mapExistingLine = (line) => ({
        id: line.id,
        product: { id: line.product_id || line.product?.id },
        quantity: Number(line.quantity),
        pricing: {
          price: String(line.unit_price ?? line.price ?? line.pricing?.price ?? 0),
          ...(line.unit_cost ?? line.cost ?? line.pricing?.cost) !== undefined
            ? { cost: String(line.unit_cost ?? line.cost ?? line.pricing?.cost) }
            : {},
          discount: String(line.unit_discount ?? line.discount ?? line.pricing?.discount ?? 0),
          loyalty_amount: String(line.unit_loyalty_value ?? line.loyalty_value ?? line.pricing?.loyalty_amount ?? 0)
        },
        tax: {
          id: line.tax_id || line.tax?.id,
          amount: String(line.unit_tax ?? line.tax ?? line.tax?.amount ?? 0)
        },
        status: line.status || 'CONFIRMED',
        ...(line.note ? { note: line.note } : {})
      });

      const payload = {
        source: {
          author_id: authorId,
          ...(registerId ? { register_id: registerId } : {}),
          type: source.type || 'HobbyCornerOrderSplitPOC',
          ...(source.id ? { id: source.id } : {})
        },
        state: original.state || 'pending',
        customer_id: original.customer_id || null,
        note: original.note || null,
        line_items: remainingLines.map(mapExistingLine),
        payments: (original.payments || []).map(payment => ({
          id: payment.id,
          ...(payment.type ? { type: payment.type } : {}),
          ...(payment.date ? { date: payment.date } : {}),
          amount: String(payment.amount ?? 0)
        }))
      };

      const updatedPayload = await client.updateSale(resolved.saleId, payload);
      const updated = unwrapData(updatedPayload) || updatedPayload;

      res.json({
        updated: true,
        originalSaleId: resolved.saleId,
        originalInvoiceNumber: original.invoice_number || null,
        removedLineItemId: lineItemId,
        removedProductId: selected.product_id || selected.product?.id || null,
        remainingLineCount: remainingLines.length,
        sale: updated
      });
    } catch (error) {
      console.error('Original sale line removal test failed:', error);
      res.status(error.status || 500).json({
        updated: false,
        error: error.message,
        details: error.details || null
      });
    }
  });

  return router;
}
