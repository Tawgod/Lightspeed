import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveExactSplitSale } from '../routes/orderSplit.js';

const client = rows => ({searchSalesByInvoiceNumber: async () => ({data: rows})});
test('exact invoice keeps leading zeros and ignores fuzzy result', async () => {
  const result = await resolveExactSplitSale(client([{id:'wrong',invoice_number:'12'},{id:'right',invoice_number:'0012'}]), '0012');
  assert.equal(result.saleId,'right');
});
test('fuzzy-only match is rejected', async () => {
  await assert.rejects(resolveExactSplitSale(client([{id:'wrong',invoice_number:'12'}]),'0012'), {status:404});
});
test('multiple exact identities are rejected', async () => {
  await assert.rejects(resolveExactSplitSale(client([{id:'a',invoice_number:'12'},{id:'b',invoice_number:'12'}]),'12'), {status:409});
});
test('duplicate rows for same identity are accepted', async () => {
  assert.equal((await resolveExactSplitSale(client([{id:'a',invoice_number:'12'},{id:'a',invoice_number:'12'}]),'12')).saleId,'a');
});
test('malformed source is unavailable, not no match', async () => {
  await assert.rejects(resolveExactSplitSale(client({unexpected:[]}), '12'), {status:502});
});
test('missing exact identity is rejected', async () => {
  await assert.rejects(resolveExactSplitSale(client([{invoice_number:'12'}]), '12'), {status:502});
});
test('UUID bypasses invoice search', async () => {
  const id='12345678-1234-1234-1234-123456789abc';
  assert.equal((await resolveExactSplitSale({},id)).saleId,id);
});
test('blank reference is rejected', async () => {
  await assert.rejects(resolveExactSplitSale({},' '), {status:400});
});
