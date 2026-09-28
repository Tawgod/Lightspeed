import express from 'express';
import { createLightspeedClient } from '../services/lightspeedApi.js';

const unwrap = (x) => x && Object.prototype.hasOwnProperty.call(x,'data') ? x.data : x;

export function createOrderSplitExecuteRouter({ domain, token }) {
  const router = express.Router();

  async function resolve(client, ref) {
    if (/^[0-9a-f-]{36}$/i.test(ref)) return ref;
    const found = unwrap(await client.searchSalesByInvoiceNumber(ref)) || [];
    const rows = Array.isArray(found) ? found : (found.sales || found.results || []);
    const sale = rows.find(s => String(s.invoice_number) === String(ref)) || rows[0];
    if (!sale?.id) {
      const e = new Error('Sale not found.');
      e.status = 404;
      throw e;
    }
    return sale.id;
  }

  router.post('/sales/:saleRef/split', async (req, res) => {
    let createdSale = null;
    try {
      const client = createLightspeedClient({ domain, token });
      const saleId = await resolve(client, req.params.saleRef);
      const original = unwrap(await client.getSale(saleId)) || {};
      const items = Array.isArray(req.body?.items) ? req.body.items : [];
      const destinationSaleRef = req.body?.destinationSaleRef ? String(req.body.destinationSaleRef).trim() : '';
      const payments = original.payments || original.register_sale_payments || [];
      const paymentTotal = payments.reduce((sum, p) => sum + Number(p.amount || 0), 0);

      if (!items.length) return res.status(400).json({ error: 'Select at least one item.' });
      if (!original.customer_id) return res.status(409).json({ error: 'Sale has no customer.' });
      if (['closed','voided'].includes(String(original.state || '').toLowerCase()))
        return res.status(409).json({ error: 'Sale state cannot be split.' });

      const selection = new Map();
      for (const x of items) {
        const q = Number(x.quantity);
        if (!x.lineItemId || !Number.isFinite(q) || q <= 0)
          return res.status(400).json({ error: 'Each item needs lineItemId and quantity > 0.' });
        selection.set(x.lineItemId, (selection.get(x.lineItemId) || 0) + q);
      }

      const sourceLines = original.line_items || [];
      const moving = [];
      const remaining = [];

      for (const line of sourceLines) {
        const moveQty = selection.get(line.id) || 0;
        const qty = Number(line.quantity || 0);
        if (moveQty > qty) return res.status(400).json({ error: 'Selected quantity exceeds source quantity.', lineItemId: line.id });
        if (moveQty) moving.push({ line, quantity: moveQty });
        if (qty - moveQty > 0) remaining.push({ line, quantity: qty - moveQty });
      }

      if (moving.length !== selection.size) return res.status(404).json({ error: 'One or more selected lines were not found.' });
      if (!remaining.length) return res.status(409).json({ error: 'Test version will not move every line off the original sale.' });

      const remainingMerchandiseTotal = remaining.reduce((sum, entry) => {
        const unitPrice = Number(entry.line.unit_price ?? entry.line.price ?? entry.line.pricing?.price ?? 0);
        const unitTax = Number(entry.line.unit_tax ?? entry.line.tax?.amount ?? entry.line.tax ?? 0);
        const unitDiscount = Number(entry.line.unit_discount ?? entry.line.discount ?? entry.line.pricing?.discount ?? 0);
        return sum + ((unitPrice - unitDiscount + unitTax) * Number(entry.quantity || 0));
      }, 0);

      if (paymentTotal - remainingMerchandiseTotal > 0.0001) {
        return res.status(409).json({
          error: 'Remaining payment/deposit would exceed the value left on the original sale.',
          paymentTotal,
          remainingMerchandiseTotal,
          additionalAmountToMoveToStoreCredit: Math.round((paymentTotal - remainingMerchandiseTotal) * 100) / 100
        });
      }

      const source = original.source || {};
      const authorId = source.author?.id || source.author_id || original.user_id || original.salesperson_id;
      const registerId = source.register_id || original.register_id;
      const originalAttributes = Array.isArray(original.attributes) ? original.attributes : [];
      if (!authorId) return res.status(422).json({ error: 'Could not determine author/cashier ID.' });

      const newLine = ({line,quantity}) => ({
        product: { id: line.product_id || line.product?.id },
        quantity,
        pricing: { price: String(line.unit_price ?? line.price ?? line.pricing?.price ?? 0) },
        tax: {
          id: line.tax_id || line.tax?.id,
          amount: String(line.unit_tax ?? line.tax?.amount ?? line.tax ?? 0)
        }
      });

      const keepLine = ({line,quantity}) => ({
        id: line.id,
        product: { id: line.product_id || line.product?.id },
        quantity,
        pricing: {
          price: String(line.unit_price ?? line.price ?? line.pricing?.price ?? 0),
          cost: String(line.unit_cost ?? line.cost ?? line.pricing?.cost ?? 0),
          discount: String(line.unit_discount ?? line.discount ?? line.pricing?.discount ?? 0),
          loyalty_amount: String(line.unit_loyalty_value ?? line.loyalty_value ?? line.pricing?.loyalty_amount ?? 0)
        },
        tax: {
          id: line.tax_id || line.tax?.id,
          amount: String(line.unit_tax ?? line.tax?.amount ?? line.tax ?? 0)
        },
        status: line.status || 'CONFIRMED'
      });

      const mapPayment = (payment) => ({
        id: payment.id,
        type: { config_id: payment.type?.config_id || payment.retailer_payment_type_id },
        ...(payment.date || payment.payment_date ? { date: payment.date || payment.payment_date } : {}),
        amount: String(payment.amount ?? 0),
        ...(payment.source?.register_id || payment.register_id
          ? { source: { register_id: payment.source?.register_id || payment.register_id } }
          : {})
      });

      const buildExistingSalePayload = (sale, mappedLines) => {
        const saleSource = sale.source || {};
        const saleAuthorId = saleSource.author?.id || saleSource.author_id || sale.user_id || sale.salesperson_id || authorId;
        const saleRegisterId = saleSource.register_id || sale.register_id;
        return {
          source: {
            author_id: saleAuthorId,
            ...(saleRegisterId ? {register_id: saleRegisterId} : {}),
            ...(saleSource.id ? {id: saleSource.id} : {}),
            ...(saleSource.type ? {type: saleSource.type} : {})
          },
          state: sale.state || 'pending',
          ...(sale.date ? {date: sale.date} : {}),
          ...(sale.invoice_number ? {invoice_number: sale.invoice_number} : {}),
          ...(sale.short_code ? {short_code: sale.short_code} : {}),
          attributes: Array.isArray(sale.attributes) ? sale.attributes : [],
          customer_id: sale.customer_id,
          note: sale.note || null,
          line_items: mappedLines,
          payments: (sale.payments || sale.register_sale_payments || []).map(mapPayment)
        };
      };

      let destination = null;
      let destinationId = null;
      let destinationBefore = null;

      if (destinationSaleRef) {
        destinationId = await resolve(client, destinationSaleRef);
        if (destinationId === saleId) {
          return res.status(409).json({ error: 'Destination order cannot be the same as the source order.' });
        }

        destination = unwrap(await client.getSale(destinationId)) || {};
        if (destination.customer_id !== original.customer_id) {
          return res.status(409).json({ error: 'Destination order belongs to a different customer.' });
        }

        const destinationState = String(destination.state || '').toLowerCase();
        if (!['pending','parked'].includes(destinationState)) {
          return res.status(409).json({ error: 'Destination order must be pending or parked.' });
        }

        destinationBefore = destination;
        const destinationLines = (destination.line_items || []).map(line => keepLine({ line, quantity: Number(line.quantity || 0) }));
        await client.updateSale(destinationId, buildExistingSalePayload(destination, [
          ...destinationLines,
          ...moving.map(newLine)
        ]));
      } else {
        createdSale = unwrap(await client.createSale({
          source: { author_id: authorId, ...(registerId ? {register_id: registerId} : {}), type: 'HobbyCornerOrderSplit' },
          state: 'parked',
          customer_id: original.customer_id,
          note: `Split from sale ${original.invoice_number || saleId}.`,
          line_items: moving.map(newLine)
        }));
        destinationId = createdSale?.id || null;
      }

      try {
        await client.updateSale(saleId, buildExistingSalePayload(original, remaining.map(keepLine)));
      } catch (e) {
        let destinationRollback = null;
        if (destinationSaleRef && destinationBefore && destinationId) {
          try {
            await client.updateSale(
              destinationId,
              buildExistingSalePayload(
                destinationBefore,
                (destinationBefore.line_items || []).map(line => keepLine({ line, quantity: Number(line.quantity || 0) }))
              )
            );
            destinationRollback = { attempted: true, restored: true };
          } catch (rollbackError) {
            destinationRollback = {
              attempted: true,
              restored: false,
              error: rollbackError.message,
              details: rollbackError.details || null
            };
          }
        }

        return res.status(e.status || 500).json({
          splitCompleted: false,
          recoveryRequired: destinationSaleRef ? !destinationRollback?.restored : true,
          error: destinationSaleRef
            ? 'Destination order was updated, but source order update failed.'
            : 'New parked sale was created, but original sale update failed.',
          createdSaleId: createdSale?.id || null,
          createdInvoiceNumber: createdSale?.invoice_number || null,
          destinationSaleId: destinationId,
          destinationRollback,
          details: e.details || null
        });
      }

      const [oldCheck,destinationCheck,fulfillCheck,destinationFulfillCheck] = await Promise.all([
        client.getSale(saleId),
        client.getSale(destinationId),
        client.getFulfillmentsForSale(saleId),
        client.getFulfillmentsForSale(destinationId)
      ]);
      const verifiedOriginal = unwrap(oldCheck) || {};
      const verifiedNew = destinationSaleRef ? {} : (unwrap(destinationCheck) || {});
      const verifiedDestination = unwrap(destinationCheck) || {};
      const fulfillments = unwrap(fulfillCheck) || [];
      const destinationFulfillments = unwrap(destinationFulfillCheck) || [];
      const currentIds = new Set((verifiedOriginal.line_items || []).map(x => x.id));
      const orphaned = [];
      for (const f of (Array.isArray(fulfillments) ? fulfillments : []))
        for (const line of (f.line_items || []))
          if (line.sale_line_item_id && !currentIds.has(line.sale_line_item_id))
            orphaned.push({ fulfillmentId:f.id, saleLineItemId:line.sale_line_item_id });

      const verifiedPaymentTotal = (verifiedOriginal.payments || []).reduce((sum, p) => sum + Number(p.amount || 0), 0);

      res.status(201).json({
        splitCompleted: true,
        originalSale: { id:saleId, invoiceNumber:verifiedOriginal.invoice_number, lineItems:verifiedOriginal.line_items || [] },
        newSale: destinationSaleRef ? null : { id:verifiedNew.id || createdSale.id, invoiceNumber:verifiedNew.invoice_number || createdSale.invoice_number, state:verifiedNew.state || createdSale.state, lineItems:verifiedNew.line_items || [] },
        destinationSale: destinationSaleRef ? {
          id: verifiedDestination.id || destinationId,
          invoiceNumber: verifiedDestination.invoice_number || destinationSaleRef,
          state: verifiedDestination.state || null,
          lineItems: verifiedDestination.line_items || []
        } : null,
        fulfillmentIntegrity: { consistent: orphaned.length === 0, orphanedLines: orphaned },
        paymentIntegrity: {
          expectedRemainingPaymentTotal: paymentTotal,
          actualRemainingPaymentTotal: verifiedPaymentTotal,
          consistent: Math.abs(verifiedPaymentTotal - paymentTotal) < 0.0001
        },
        destinationFulfillment: destinationSaleRef ? {
          fulfillmentCount: Array.isArray(destinationFulfillments) ? destinationFulfillments.length : 0
        } : null
      });
    } catch (e) {
      res.status(e.status || 500).json({
        splitCompleted: false,
        recoveryRequired: Boolean(createdSale?.id),
        createdSaleId: createdSale?.id || null,
        error: e.message,
        details: e.details || null
      });
    }
  });

  router.post('/sales/:saleRef/repair-pickup', async (req, res) => {
    try {
      const client = createLightspeedClient({ domain, token });
      const saleId = await resolve(client, req.params.saleRef);
      const original = unwrap(await client.getSale(saleId)) || {};
      const fulfillments = unwrap(await client.getFulfillmentsForSale(saleId)) || [];
      const hasPickup = (Array.isArray(fulfillments) ? fulfillments : []).some(f => f.type === 'PICKUP');

      if (!hasPickup) {
        return res.status(409).json({ repaired: false, error: 'No PICKUP fulfillment exists for this sale.' });
      }

      const source = original.source || {};
      const authorId = source.author?.id || source.author_id || original.user_id || original.salesperson_id;
      const registerId = source.register_id || original.register_id;
      if (!authorId) return res.status(422).json({ repaired:false, error:'Could not determine author/cashier ID.' });

      const attributes = Array.from(new Set([...(Array.isArray(original.attributes) ? original.attributes : []), 'pickup']));

      const lines = (original.line_items || []).map(line => ({
        id: line.id,
        product: { id: line.product_id || line.product?.id },
        quantity: Number(line.quantity || 0),
        pricing: {
          price: String(line.unit_price ?? line.price ?? line.pricing?.price ?? 0),
          cost: String(line.unit_cost ?? line.cost ?? line.pricing?.cost ?? 0),
          discount: String(line.unit_discount ?? line.discount ?? line.pricing?.discount ?? 0),
          loyalty_amount: String(line.unit_loyalty_value ?? line.loyalty_value ?? line.pricing?.loyalty_amount ?? 0)
        },
        tax: {
          id: line.tax_id || line.tax?.id,
          amount: String(line.unit_tax ?? line.tax?.amount ?? line.tax ?? 0)
        },
        status: line.status || 'CONFIRMED'
      }));

      const updated = unwrap(await client.updateSale(saleId, {
        source: {
          author_id: authorId,
          ...(registerId ? {register_id: registerId} : {}),
          ...(source.id ? {id: source.id} : {}),
          ...(source.type ? {type: source.type} : {})
        },
        state: original.state || 'pending',
        ...(original.date ? {date: original.date} : {}),
        ...(original.invoice_number ? {invoice_number: original.invoice_number} : {}),
        ...(original.short_code ? {short_code: original.short_code} : {}),
        attributes,
        customer_id: original.customer_id || null,
        note: original.note || null,
        line_items: lines,
        payments: original.payments || []
      }));

      res.json({
        repaired: true,
        saleId,
        invoiceNumber: updated?.invoice_number || original.invoice_number || null,
        attributes: updated?.attributes || attributes,
        lineItemCount: (updated?.line_items || original.line_items || []).length
      });
    } catch (e) {
      res.status(e.status || 500).json({ repaired:false, error:e.message, details:e.details || null });
    }
  });

  return router;
}
