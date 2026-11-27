import express from 'express';
import { createLightspeedClient } from '../services/lightspeedApi.js';

function unwrapData(payload) {
  if (payload && Object.prototype.hasOwnProperty.call(payload, 'data')) {
    return payload.data;
  }
  return payload;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
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

export async function resolveExactSplitSale(client, saleRef) {
  const ref = String(saleRef ?? '').trim();
  const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
  if (!ref) fail(400, 'Sale reference required.');
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref)) {
    return { saleId: ref, matchedBy: 'id' };
  }
  const results = unwrapData(await client.searchSalesByInvoiceNumber(ref));
  const rows = Array.isArray(results) ? results : (results?.sales ?? results?.results);
  if (!Array.isArray(rows)) fail(502, 'Sale search returned an invalid response.');
  const exact = rows.filter(s => String(s?.invoice_number ?? s?.invoiceNumber ?? '') === ref);
  if (!exact.length) fail(404, 'No exact sale reference found.');
  if (exact.some(s => typeof s.id !== 'string' || !s.id.trim())) fail(502, 'Exact sale has no valid ID.');
  const ids = new Set(exact.map(s => s.id));
  if (ids.size !== 1) fail(409, 'Ambiguous sale reference; select the exact order.');
  return { saleId: exact[0].id, matchedBy: 'invoice_number', matchedSale: exact[0] };
}

export function createOrderSplitRouter({ domain, token }) {
  const router = express.Router();

  const resolveSaleId = resolveExactSplitSale;

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
            ? 'Review existing payment/deposit in Lightspeed Register before splitting; no credit conversion is performed here.'
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



  // Simple browser test harness.
  router.get('/sales/:saleId/test', async (req, res) => {
    try {
      const client = createLightspeedClient({ domain, token });
      const saleRef = req.params.saleId;
      const resolved = await resolveSaleId(client, saleRef);
      const sale = unwrapData(await client.getSale(resolved.saleId)) || {};
      const lines = sale.line_items || [];
      const payments = sale.payments || [];

      const uniqueProductIds = [...new Set(lines.map(line => line.product_id).filter(Boolean))];
      const productEntries = await Promise.all(uniqueProductIds.map(async (productId) => {
        try {
          const product = unwrapData(await client.getProduct(productId)) || {};
          return [productId, product];
        } catch {
          return [productId, {}];
        }
      }));
      const productsById = Object.fromEntries(productEntries);
      const paymentTotal = payments.reduce((sum, p) => sum + Number(p.amount || 0), 0);

      let storeCreditBalance = null;
      if (sale.customer_id) {
        try {
          const credit = unwrapData(await client.getStoreCredit(sale.customer_id)) || {};
          storeCreditBalance = Number(credit.balance || 0);
        } catch {
          storeCreditBalance = null;
        }
      }

      const storeCreditDisplay = storeCreditBalance == null
        ? 'Unavailable'
        : 'USD ' + storeCreditBalance.toFixed(2);
      const paymentTotalDisplay = 'USD ' + paymentTotal.toFixed(2);

      const rows = lines.map((line) => {
        const price = line.unit_price ?? line.price ?? 0;
        const qty = Number(line.quantity || 1);
        const product = productsById[line.product_id] || {};
        const productName = product.name || 'Unknown Product';
        const sku = product.sku || product.code || 'No SKU';
        return `
          <tr>
            <td style="padding:8px;border-bottom:1px solid #ddd;"><input type="checkbox" class="split-select" data-line-id="${line.id}"></td>
            <td style="padding:8px;border-bottom:1px solid #ddd;"><strong>${escapeHtml(productName)}</strong></td>
            <td style="padding:8px;border-bottom:1px solid #ddd;">${escapeHtml(sku)}</td>
            <td style="padding:8px;border-bottom:1px solid #ddd;">${qty}</td>
            <td style="padding:8px;border-bottom:1px solid #ddd;"><input type="number" min="1" max="${qty}" value="1" class="split-qty" data-line-id="${line.id}" style="width:70px;padding:4px;"></td>
            <td style="padding:8px;border-bottom:1px solid #ddd;">${Number(price).toFixed(2)}</td>

          </tr>`;
      }).join('');

      res.type('html').send(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>Order Split Test</title></head>
<body style="font-family:Arial,sans-serif;max-width:1100px;margin:30px auto;padding:0 20px;">
<h1>Order Split Test — Sale ${sale.invoice_number || saleRef}</h1>
<p><strong>Use the actions below only for test orders.</strong></p>
<div style="margin:16px 0;padding:12px;border:1px solid #ddd;background:#fafafa;">
  <div><strong>Current store credit:</strong> ${storeCreditDisplay}</div>
  <div><strong>Current payment/deposit total:</strong> ${paymentTotalDisplay}</div>
  <p>Payments and customer credit are handled in Lightspeed Register. Payment and credit amounts shown here are read-only.</p>
  <div style="margin-top:10px;">
    <label><strong>Destination:</strong>
      <select id="split-destination" style="padding:5px;margin-left:6px;min-width:260px;">
        <option value="">Create a new parked order</option>
      </select>
    </label>
    <div id="destination-note" style="font-size:12px;color:#666;margin-top:4px;">Loading other open orders for this customer...</div>
  </div>
</div>
<table style="border-collapse:collapse;width:100%;">
<thead><tr><th>Select</th><th>Product</th><th>SKU</th><th>Qty</th><th>Split Qty</th><th>Price</th></tr></thead>
<tbody>${rows}</tbody>
</table>
<button id="pickup-selected-btn" onclick="splitSelected(true)" style="margin-top:16px;padding:11px 18px;font-weight:800;background:#16a34a;color:#fff;border:2px solid #14532d;border-radius:6px;">Pick Up Selected → Register</button>
<button id="split-selected-btn" onclick="splitSelected(false)" style="margin-top:16px;margin-left:8px;padding:10px 16px;font-weight:bold;">Split Selected Only</button>
<pre id="result" style="margin-top:20px;background:#f5f5f5;padding:15px;white-space:pre-wrap;"></pre>
<script>
async function loadDestinations() {
  const select = document.getElementById('split-destination');
  const note = document.getElementById('destination-note');
  if (!select || !note) return;
  try {
    const response = await fetch('/api/work-orders/sales/${encodeURIComponent(saleRef)}/combine-preview');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load destinations.');
    const orders = data.otherOpenWorkOrders || [];
    for (const order of orders) {
      const option = document.createElement('option');
      option.value = String(order.invoiceNumber || order.id || '');
      option.textContent = 'Add to existing order ' + String(order.invoiceNumber || '') +
        ' (' + String(order.state || '') + ', ' + String(order.lineCount || 0) + ' lines)';
      select.appendChild(option);
    }
    note.textContent = orders.length
      ? 'Choose an existing open order for this customer, or leave New Order selected.'
      : 'No other open work orders found. A new parked order will be created.';
  } catch (error) {
    note.textContent = 'Could not load existing-order destinations: ' + error.message;
  }
}

let splitSubmitted = false;
async function splitSelected(loadRegister = false) {
  if (splitSubmitted) return;
  const selected = [...document.querySelectorAll('.split-select:checked')];
  if (!selected.length) {
    alert('Select at least one item to split.');
    return;
  }
  const items = selected.map(box => {
    const lineItemId = box.dataset.lineId;
    const qtyInput = document.querySelector('.split-qty[data-line-id="' + lineItemId + '"]');
    return { lineItemId, quantity: parseInt(qtyInput && qtyInput.value ? qtyInput.value : '1', 10) };
  });
  const destinationSaleRef = document.getElementById('split-destination')?.value || '';
  const destinationMessage = destinationSaleRef
    ? (loadRegister
        ? 'Move the selected items to existing order ' + destinationSaleRef + ' and load that order into the register?'
        : 'Add the selected items to existing order ' + destinationSaleRef + ' and remove them from this order?')
    : (loadRegister
        ? 'Create a pickup order for the selected items, remove them from the original order, and load the pickup order into the register?'
        : 'Create a new split order for the selected items and remove them from the original sale?');
  if (!confirm(destinationMessage)) return;
  const out = document.getElementById('result');
  splitSubmitted = true;
  document.getElementById('pickup-selected-btn').disabled = true;
  document.getElementById('split-selected-btn').disabled = true;
  out.textContent = loadRegister ? 'Preparing selected pickup...' : 'Running combined split...';
  try {
    const response = await fetch('/api/order-split/sales/${encodeURIComponent(saleRef)}/split', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ items, destinationSaleRef: destinationSaleRef || null })
    });
    const data = await response.json();
    out.textContent = JSON.stringify(data, null, 2);
    if (response.ok && data.splitCompleted === true && data.recoveryRequired !== true && data.fulfillmentIntegrity?.consistent === true && data.paymentIntegrity?.consistent === true && (!loadRegister || Boolean(data.destinationSale?.id || data.newSale?.id))) {
      const destinationSaleId = data.destinationSale?.id || data.newSale?.id || null;
      setTimeout(() => {
        window.parent.postMessage(loadRegister ? {
          type: 'HCT_PICKUP_TO_REGISTER',
          saleId: destinationSaleId,
          originalInvoiceNumber: data.originalSale?.invoiceNumber || null,
          destinationInvoiceNumber: data.destinationSale?.invoiceNumber || data.newSale?.invoiceNumber || null
        } : {
          type: 'HCT_SPLIT_COMPLETE',
          originalInvoiceNumber: data.originalSale?.invoiceNumber || null,
          destinationInvoiceNumber: data.destinationSale?.invoiceNumber || data.newSale?.invoiceNumber || null
        }, '*');
      }, loadRegister ? 300 : 900);
    } else {
      out.textContent = 'Split not verified. Check the original and destination orders before attempting another split. ' + JSON.stringify(data, null, 2);
    }
  } catch (error) {
    out.textContent = 'Split outcome unknown. Check both orders before retrying. ' + String(error);
  }
}

loadDestinations();

</script>
</body></html>`);
    } catch (error) {
      res.status(error.status || 500).send('Unable to load split test page: ' + error.message);
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
