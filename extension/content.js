const HCT_BACKEND = 'https://lightspeed-production.up.railway.app';

function extractPurchaseOrderId() {
  const match = location.pathname.match(/\/inventory\/purchase-order\/([^/?#]+)/i);
  return match ? match[1] : null;
}

function extractSaleRef() {
  const pathMatches = [
    /\/sales?\/([0-9]+)(?:\/|$)/i,
    /\/sale\/([0-9]+)(?:\/|$)/i,
    /\/orders?\/([0-9]+)(?:\/|$)/i
  ];
  for (const pattern of pathMatches) {
    const match = location.pathname.match(pattern);
    if (match) return match[1];
  }

  const text = document.body?.innerText || '';
  const candidates = [
    /Invoice\s*#?\s*([0-9]+)/i,
    /Sale\s*#?\s*([0-9]+)/i,
    /Order\s*#?\s*([0-9]+)/i
  ];
  for (const pattern of candidates) {
    const match = text.match(pattern);
    if (match) return match[1];
  }
  return '';
}

function ensurePoLabelButton() {
  const poId = extractPurchaseOrderId();
  if (!poId || document.getElementById('hct-print-labels')) return;

  const button = document.createElement('button');
  button.id = 'hct-print-labels';
  button.textContent = '🖨️ Print Avery Labels';
  Object.assign(button.style, {
    position:'fixed',
    right:'20px',
    bottom:'20px',
    zIndex:'2147483647',
    padding:'10px 14px',
    borderRadius:'6px',
    border:'1px solid #bbb',
    background:'#fff',
    cursor:'pointer',
    boxShadow:'0 2px 8px rgba(0,0,0,.15)'
  });
  button.addEventListener('click', () => {
    window.open(HCT_BACKEND + '/index.html?poId=' + encodeURIComponent(poId), '_blank');
  });
  document.body.appendChild(button);
}

ensurePoLabelButton();
new MutationObserver(ensurePoLabelButton).observe(document.documentElement, {childList:true, subtree:true});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'HCT_GET_CONTEXT') {
    sendResponse({
      url: location.href,
      saleRef: extractSaleRef(),
      purchaseOrderId: extractPurchaseOrderId()
    });
  }
});
