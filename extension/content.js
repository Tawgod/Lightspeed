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
ensureSplitLauncher();
new MutationObserver(() => {
  ensurePoLabelButton();
  ensureSplitLauncher();
}).observe(document.documentElement, {childList:true, subtree:true});

function splitLauncherMode() {
  const path = location.pathname.toLowerCase();
  if (path === '/webregister' || path.startsWith('/webregister/')) {
    return { label: '↩ Recall / Split Order', mode: 'sell' };
  }

  if (
    path.includes('/fulfillment') ||
    path.includes('/fulfilment') ||
    path.includes('/pickup') ||
    path.includes('/pick-up')
  ) {
    return { label: '✂ Split / Partial Pickup', mode: 'fulfillment' };
  }

  return null;
}

function ensureSplitLauncher() {
  const config = splitLauncherMode();
  const existing = document.getElementById('hct-split-launcher');

  if (!config) {
    existing?.remove();
    return;
  }

  if (existing) {
    if (existing.textContent !== config.label) {
      existing.textContent = config.label;
    }
    return;
  }

  const button = document.createElement('button');
  button.id = 'hct-split-launcher';
  button.textContent = config.label;
  Object.assign(button.style, {
    position:'fixed',
    right:'20px',
    bottom:'20px',
    zIndex:'2147483645',
    padding:'11px 16px',
    borderRadius:'7px',
    border:'2px solid #0f172a',
    background:'#2563eb',
    color:'#fff',
    fontWeight:'800',
    fontSize:'14px',
    cursor:'pointer',
    boxShadow:'0 4px 14px rgba(0,0,0,.35)'
  });
  button.addEventListener('click', () => {
    openSplitOverlay(extractSaleRef());
  });

  document.body.appendChild(button);
}

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
  title.textContent = saleRef
    ? 'Hobby Corner — Split Order ' + saleRef
    : 'Hobby Corner — Recall / Split Order';

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

  bar.append(title, close);
  panel.appendChild(bar);

  const loadOrder = (ref) => {
    const cleanRef = String(ref || '').trim();
    if (!cleanRef) return;

    title.textContent = 'Hobby Corner — Split Order ' + cleanRef;
    const existingFrame = panel.querySelector('iframe');
    existingFrame?.remove();
    const existingLookup = panel.querySelector('[data-hct-order-lookup]');
    existingLookup?.remove();

    const frame = document.createElement('iframe');
    frame.src = HCT_BACKEND + '/api/order-split/sales/' + encodeURIComponent(cleanRef) + '/test?embedded=1';
    Object.assign(frame.style, {
      width:'100%',
      flex:'1',
      border:'0',
      background:'#fff'
    });
    panel.appendChild(frame);
  };

  if (saleRef) {
    loadOrder(saleRef);
  } else {
    const lookup = document.createElement('div');
    lookup.dataset.hctOrderLookup = '1';
    Object.assign(lookup.style, {
      flex:'1',
      display:'flex',
      alignItems:'center',
      justifyContent:'center',
      padding:'30px',
      fontFamily:'Arial,sans-serif',
      background:'#f8fafc'
    });

    const card = document.createElement('div');
    Object.assign(card.style, {
      width:'min(480px, 92%)',
      background:'#fff',
      border:'1px solid #cbd5e1',
      borderRadius:'10px',
      padding:'24px',
      boxShadow:'0 8px 24px rgba(15,23,42,.10)'
    });

    const heading = document.createElement('h2');
    heading.textContent = 'Recall an order';
    Object.assign(heading.style, { margin:'0 0 8px', color:'#0f172a' });

    const help = document.createElement('p');
    help.textContent = 'Enter the Lightspeed invoice/order number you want to split or partially pick up.';
    Object.assign(help.style, { margin:'0 0 16px', color:'#475569', lineHeight:'1.4' });

    const input = document.createElement('input');
    input.type = 'text';
    input.inputMode = 'numeric';
    input.placeholder = 'Invoice / order number';
    Object.assign(input.style, {
      width:'100%',
      boxSizing:'border-box',
      padding:'11px 12px',
      border:'1px solid #94a3b8',
      borderRadius:'6px',
      fontSize:'16px',
      marginBottom:'10px'
    });

    const open = document.createElement('button');
    open.textContent = 'Open Split / Partial Pickup';
    Object.assign(open.style, {
      width:'100%',
      padding:'11px 14px',
      border:'2px solid #0f172a',
      borderRadius:'6px',
      background:'#2563eb',
      color:'#fff',
      fontWeight:'800',
      cursor:'pointer'
    });

    const submit = () => {
      const ref = input.value.trim();
      if (!ref) {
        input.focus();
        return;
      }
      loadOrder(ref);
    };

    open.addEventListener('click', submit);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') submit();
    });

    card.append(heading, help, input, open);
    lookup.appendChild(card);
    panel.appendChild(lookup);
    setTimeout(() => input.focus(), 0);
  }

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
