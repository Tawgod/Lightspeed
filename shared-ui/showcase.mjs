import {copyHobbyCornerField} from './clipboard.mjs';

const byId = id => document.getElementById(id);
const feedback = byId('feedback');
function notice(message, kind = 'info') {
  feedback.className = 'hc-alert' + (kind === 'success' ? ' hc-alert--success' : kind === 'warning' ? ' hc-alert--warning' : '');
  feedback.textContent = message;
}
byId('show-loading').addEventListener('click', () => {
  feedback.className = 'hc-inset hc-loading';
  feedback.textContent = 'Loading sample data…';
  const btn = byId('show-loading');
  btn.disabled = true;
  setTimeout(() => { btn.disabled = false; notice('Sample loading finished. No remote request was made.', 'success'); }, 650);
});
byId('show-empty').addEventListener('click', () => notice('No sample items found. Adjust your filters or search terms.'));
byId('show-success').addEventListener('click', () => notice('Example action completed. No store data was changed.', 'success'));
byId('sample-refresh').addEventListener('click', () => notice('Example list refreshed locally; no data was fetched.'));
byId('sample-search').addEventListener('input', event => {
  const term = event.target.value.toLocaleLowerCase().trim();
  let count = 0;
  for (const row of byId('sample-rows').querySelectorAll('tr')) {
    const match = row.textContent.toLocaleLowerCase().includes(term);
    row.hidden = !match;
    count += Number(match);
  }
  byId('no-results').hidden = count !== 0;
});
byId('sample-rows').addEventListener('click', event => {
  const btn = event.target.closest('[data-preview]');
  if (btn) notice(btn.dataset.preview + ' is sample content, not an actual order.');
});
const modal = byId('example-dialog');
const openModal = () => modal.showModal();
byId('open-confirmation').addEventListener('click', openModal);
byId('danger-sample').addEventListener('click', openModal);
byId('cancel-dialog').addEventListener('click', () => modal.close());
byId('confirm-dialog').addEventListener('click', () => {modal.close();notice('Preview closed; no changes were made.');});
byId('review-demo').addEventListener('click', () => {
  const sku = byId('example-sku').value;
  const qty = byId('example-quantity').value;
  if (!sku || !Number.isSafeInteger(Number(qty)) || Number(qty) < 1) {
    notice('Enter a SKU and positive whole-number quantity before review.', 'warning'); return;
  }
  notice('Preview only — SKU ' + sku + ', quantity ' + qty + '. No product created.');
});
byId('reset-demo').addEventListener('click', () => {
  byId('example-sku').value = '0000123405';
  byId('example-quantity').value = '1';
  byId('example-note').value = 'Keep exact whitespace\nand line breaks.';
  notice('Sample form restored locally.');
});
for (const id of ['primary-sample','secondary-sample','quiet-sample']) {
  byId(id).addEventListener('click', () => notice('Example ' + id.replace('-sample','') + ' action; no data changed.'));
}
byId('copy-plain').addEventListener('click', async () => {
  try {
    const copied = await copyHobbyCornerField({plainText:byId('copy-content').value});
    byId('copy-status').textContent = 'Copied exact ' + copied.format + ' text. Spaces, newlines and leading zeros preserved.';
  } catch (error) {
    byId('copy-status').textContent = 'Copy unavailable: ' + error.message + '. Select the source field and copy it manually.';
  }
});
