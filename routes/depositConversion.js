import express from 'express';
import { createHash } from 'node:crypto';
import { createLightspeedClient } from '../services/lightspeedApi.js';

const unwrap = (x) => x && Object.prototype.hasOwnProperty.call(x, 'data') ? x.data : x;

export function createDepositConversionRouter({ domain, token }) {
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

  const mapLine = (line) => ({
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
    status: line.status || 'CONFIRMED',
    ...(line.note ? { note: line.note } : {})
  });

  const mapPayment = (payment, amountOverride) => ({
    ...(payment.id ? { id: payment.id } : {}),
    type: {
      config_id: payment.type?.config_id || payment.retailer_payment_type_id
    },
    ...(payment.date || payment.payment_date ? { date: payment.date || payment.payment_date } : {}),
    amount: String(amountOverride ?? payment.amount ?? 0),
    ...(payment.source?.register_id || payment.register_id
      ? { source: { register_id: payment.source?.register_id || payment.register_id } }
      : {})
  });

  function baseSalePayload(original, payments) {
    const source = original.source || {};
    const authorId = source.author?.id || source.author_id || original.user_id || original.salesperson_id;
    const registerId = source.register_id || original.register_id;
    if (!authorId) {
      const e = new Error('Could not determine author/cashier ID.');
      e.status = 422;
      throw e;
    }

    return {
      source: {
        author_id: authorId,
        ...(registerId ? { register_id: registerId } : {}),
        ...(source.id ? { id: source.id } : {}),
        ...(source.type ? { type: source.type } : {})
      },
      state: original.state || 'pending',
      ...(original.date ? { date: original.date } : {}),
      ...(original.invoice_number ? { invoice_number: original.invoice_number } : {}),
      ...(original.short_code ? { short_code: original.short_code } : {}),
      attributes: Array.isArray(original.attributes) ? original.attributes : [],
      customer_id: original.customer_id || null,
      note: original.note || null,
      line_items: (original.line_items || []).map(mapLine),
      payments
    };
  }

  router.post('/sales/:saleRef/convert-deposit', async (req, res) => {
    const client = createLightspeedClient({ domain, token });
    let original = null;
    let paymentRemoved = false;

    try {
      const saleId = await resolve(client, req.params.saleRef);
      original = unwrap(await client.getSale(saleId)) || {};

      if (!original.customer_id) {
        return res.status(409).json({ converted:false, error:'Sale has no customer.' });
      }
      if (['closed','voided'].includes(String(original.state || '').toLowerCase())) {
        return res.status(409).json({ converted:false, error:'Sale state cannot be converted.' });
      }

      const payments = original.payments || [];
      if (!payments.length) {
        return res.status(409).json({ converted:false, error:'Sale has no payment/deposit to convert.' });
      }

      const paymentTotal = payments.reduce((sum,p) => sum + Number(p.amount || 0), 0);
      if (!(paymentTotal > 0)) {
        return res.status(409).json({ converted:false, error:'No positive payment amount detected.', paymentTotal });
      }

      const requestedAmount = req.body?.amount == null ? paymentTotal : Number(req.body.amount);
      if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) {
        return res.status(400).json({ converted:false, error:'Conversion amount must be greater than zero.' });
      }
      if (requestedAmount - paymentTotal > 0.0001) {
        return res.status(400).json({
          converted:false,
          error:'Conversion amount cannot exceed the current payment/deposit total.',
          requestedAmount,
          paymentTotal
        });
      }
      const amount = Math.round(requestedAmount * 100) / 100;

      for (const p of payments) {
        const configId = p.type?.config_id || p.retailer_payment_type_id;
        if (!configId) {
          return res.status(422).json({
            converted:false,
            error:'A payment is missing its payment type config ID, so rollback would not be safe.',
            paymentId:p.id || null
          });
        }
      }

      const creditBefore = unwrap(await client.getStoreCredit(original.customer_id)) || {};
      const balanceBefore = Number(creditBefore.balance || 0);

      let leftToConvert = amount;
      const adjustedPayments = payments.map(p => {
        const current = Number(p.amount || 0);
        const reduction = Math.min(current, leftToConvert);
        leftToConvert = Math.round((leftToConvert - reduction) * 100) / 100;
        return mapPayment(p, Math.round((current - reduction) * 100) / 100);
      });

      const cleared = unwrap(await client.updateSale(saleId, baseSalePayload(original, adjustedPayments))) || {};
      paymentRemoved = true;

      const verifyCleared = unwrap(await client.getSale(saleId)) || {};
      const verifiedPayments = verifyCleared.payments || [];
      const remainingPaymentTotal = verifiedPayments.reduce((sum, p) => sum + Number(p.amount || 0), 0);
      const expectedRemaining = Math.round((paymentTotal - amount) * 100) / 100;
      if (Math.abs(remainingPaymentTotal - expectedRemaining) > 0.0001) {
        throw Object.assign(new Error('Payment reduction did not verify cleanly.'), {
          status: 502,
          details: { remainingPaymentTotal, expectedRemaining, payments: verifiedPayments }
        });
      }

      const paymentFingerprint = payments
        .map(p => (p.id || '') + ':' + Number(p.amount || 0).toFixed(2))
        .join('|');
      const clientId = 'hcs-' + createHash('sha256')
        .update(saleId + ':' + paymentFingerprint + ':' + amount.toFixed(2))
        .digest('hex')
        .slice(0, 32);

      let creditTxn;
      try {
        const authorId = original.source?.author?.id || original.source?.author_id || original.user_id || original.salesperson_id;
        creditTxn = unwrap(await client.createStoreCreditTransaction(original.customer_id, {
          amount,
          type: 'ISSUE',
          client_id: clientId,
          notes: `Deposit from sale ${original.invoice_number || saleId} converted to store credit for order split.`,
          ...(authorId ? { user_id: authorId } : {})
        }));
      } catch (creditError) {
        let rollback = { attempted:true, restored:false, error:null };
        try {
          await client.updateSale(saleId, baseSalePayload(original, payments.map(p => mapPayment(p))));
          const check = unwrap(await client.getSale(saleId)) || {};
          const restoredPayments = check.payments || [];
          const restoredTotal = restoredPayments.reduce((sum, p) => sum + Number(p.amount || 0), 0);
          rollback.restored = Math.abs(restoredTotal - paymentTotal) < 0.0001;
        } catch (rollbackError) {
          rollback.error = rollbackError.message;
        }

        return res.status(creditError.status || 500).json({
          converted:false,
          recoveryRequired: !rollback.restored,
          error:'Store-credit issuance failed after payment removal.',
          details:creditError.details || null,
          rollback
        });
      }

      const creditAfter = unwrap(await client.getStoreCredit(original.customer_id)) || {};
      const balanceAfter = Number(creditAfter.balance || 0);

      res.json({
        converted:true,
        saleId,
        invoiceNumber: original.invoice_number || null,
        convertedPaymentAmount: amount,
        originalPaymentTotal: paymentTotal,
        remainingPaymentTotal,
        storeCredit: {
          clientId,
          balanceBefore,
          balanceAfter,
          expectedIncrease: amount,
          verifiedIncrease: Math.abs((balanceAfter - balanceBefore) - amount) < 0.0001,
          transaction: creditTxn
        },
        sale: {
          paymentRecordsRemaining: (verifyCleared.payments || []).length,
          remainingPaymentTotal: (verifyCleared.payments || []).reduce((sum, p) => sum + Number(p.amount || 0), 0)
        }
      });
    } catch (e) {
      res.status(e.status || 500).json({
        converted:false,
        recoveryRequired: paymentRemoved,
        error:e.message,
        details:e.details || null
      });
    }
  });

  return router;
}
