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
    border:'2px solid #111827',
    background:'#facc15',
    color:'#111827',
    fontWeight:'800',
    cursor:'pointer',
    boxShadow:'0 3px 10px rgba(0,0,0,.35)'
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

  if (message?.type === 'HCT_OPEN_SPLIT') {
    openSplitOverlay(String(message.saleRef || extractSaleRef() || '').trim());
    sendResponse({ opened: true });
  }
});


function closeSplitOverlay() {
  document.getElementById('hct-split-overlay')?.remove();
}

function openSplitOverlay(saleRef) {
  closeSplitOverlay();

  const overlay = document.createElement('div');
  overlay.id = 'hct-split-overlay';
  Object.assign(overlay.style, {
    position:'fixed',
    inset:'0',
    zIndex:'2147483646',
    background:'rgba(15,23,42,.68)',
    display:'flex',
    alignItems:'center',
    justifyContent:'center',
    padding:'28px'
  });

  const panel = document.createElement('div');
  Object.assign(panel.style, {
    width:'min(1180px, 96vw)',
    height:'min(820px, 92vh)',
    background:'#fff',
    borderRadius:'12px',
    overflow:'hidden',
    boxShadow:'0 20px 60px rgba(0,0,0,.45)',
    display:'flex',
    flexDirection:'column'
  });

  const bar = document.createElement('div');
  Object.assign(bar.style, {
    display:'flex',
    alignItems:'center',
    justifyContent:'space-between',
    padding:'10px 14px',
    background:'#111827',
    color:'#fff',
    fontFamily:'Arial,sans-serif',
    fontWeight:'700'
  });

  const title = document.createElement('div');
  title.textContent = 'Hobby Corner — Split Order ' + saleRef;

  const close = document.createElement('button');
  close.textContent = 'Close';
  Object.assign(close.style, {
    border:'1px solid rgba(255,255,255,.45)',
    background:'#fff',
    color:'#111827',
    borderRadius:'6px',
    padding:'7px 11px',
    cursor:'pointer',
    fontWeight:'700'
  });
  close.addEventListener('click', closeSplitOverlay);

  const frame = document.createElement('iframe');
  frame.src = HCT_BACKEND + '/api/order-split/sales/' + encodeURIComponent(saleRef) + '/test?embedded=1';
  Object.assign(frame.style, {
    width:'100%',
    flex:'1',
    border:'0',
    background:'#fff'
  });

  bar.append(title, close);
  panel.append(bar, frame);
  overlay.appendChild(panel);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) closeSplitOverlay();
  });
  document.body.appendChild(overlay);
}

window.addEventListener('message', (event) => {
  if (event.origin !== new URL(HCT_BACKEND).origin) return;
  if (event.data?.type === 'HCT_SPLIT_COMPLETE') {
    closeSplitOverlay();
  }
});
