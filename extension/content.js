const HCT_BACKEND = 'https://lightspeed-api-production-c087.up.railway.app';

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
      width:'min(760px, 94%)',
      background:'#fff',
      border:'1px solid #cbd5e1',
      borderRadius:'10px',
      padding:'22px',
      boxShadow:'0 8px 24px rgba(15,23,42,.10)'
    });

    const heading = document.createElement('h2');
    heading.textContent = 'Recall / Split Order';
    Object.assign(heading.style, { margin:'0 0 8px', color:'#0f172a' });

    const help = document.createElement('p');
    help.textContent = 'Choose an eligible open order below, or search by customer name or invoice number.';
    Object.assign(help.style, { margin:'0 0 14px', color:'#475569', lineHeight:'1.4' });

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Search customer or invoice number';
    Object.assign(input.style, {
      width:'100%',
      boxSizing:'border-box',
      padding:'11px 12px',
      border:'1px solid #94a3b8',
      borderRadius:'6px',
      fontSize:'16px',
      marginBottom:'10px'
    });

    const list = document.createElement('div');
    Object.assign(list.style, {
      maxHeight:'390px',
      overflowY:'auto',
      border:'1px solid #e2e8f0',
      borderRadius:'8px',
      background:'#f8fafc'
    });

    const status = document.createElement('div');
    status.textContent = 'Loading eligible orders...';
    Object.assign(status.style, {
      padding:'14px',
      color:'#64748b',
      fontSize:'13px'
    });
    list.appendChild(status);

    const manualRow = document.createElement('div');
    Object.assign(manualRow.style, {
      display:'flex',
      gap:'8px',
      marginTop:'12px'
    });

    const manualInput = document.createElement('input');
    manualInput.type = 'text';
    manualInput.inputMode = 'numeric';
    manualInput.placeholder = 'Or enter invoice/order number';
    Object.assign(manualInput.style, {
      flex:'1',
      padding:'10px 11px',
      border:'1px solid #94a3b8',
      borderRadius:'6px',
      fontSize:'14px'
    });

    const open = document.createElement('button');
    open.textContent = 'Open';
    Object.assign(open.style, {
      padding:'10px 16px',
      border:'2px solid #0f172a',
      borderRadius:'6px',
      background:'#2563eb',
      color:'#fff',
      fontWeight:'800',
      cursor:'pointer'
    });

    let orders = [];

    const renderOrders = () => {
      const query = input.value.trim().toLowerCase();
      const filtered = orders.filter(order => {
        const haystack = [
          order.customerName,
          order.company,
          order.invoiceNumber,
          order.state,
          ...(order.attributes || [])
        ].filter(Boolean).join(' ').toLowerCase();
        return !query || haystack.includes(query);
      });

      list.innerHTML = '';

      if (!filtered.length) {
        const empty = document.createElement('div');
        empty.textContent = orders.length
          ? 'No eligible orders match your search.'
          : 'No eligible open orders were found.';
        Object.assign(empty.style, {
          padding:'16px',
          color:'#64748b',
          fontSize:'13px'
        });
        list.appendChild(empty);
        return;
      }

      for (const order of filtered) {
        const row = document.createElement('div');
        Object.assign(row.style, {
          display:'flex',
          alignItems:'center',
          gap:'10px',
          width:'100%',
          boxSizing:'border-box',
          padding:'12px 14px',
          borderBottom:'1px solid #e2e8f0',
          background:'#fff',
          color:'#0f172a'
        });

        const details = document.createElement('button');
        details.type = 'button';
        Object.assign(details.style, {
          flex:'1',
          minWidth:'0',
          textAlign:'left',
          padding:'0',
          border:'0',
          background:'transparent',
          cursor:'pointer',
          color:'#0f172a'
        });

        const titleLine = document.createElement('div');
        titleLine.textContent = (order.customerName || 'Customer') + ' — Invoice ' + (order.invoiceNumber || '');
        Object.assign(titleLine.style, {
          fontWeight:'800',
          fontSize:'14px',
          marginBottom:'4px'
        });

        const attrs = (order.attributes || []).join(', ');
        const meta = document.createElement('div');
        meta.textContent =
          (attrs || order.state || 'open') +
          ' · ' + String(order.lineCount || 0) + ' lines' +
          ' · Qty ' + String(order.quantityTotal || 0) +
          ' · Payment 
      }
    };

    fetch(HCT_BACKEND + '/api/work-orders/eligible')
      .then(async response => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Could not load eligible orders.');
        orders = Array.isArray(data.orders) ? data.orders : [];
        renderOrders();
      })
      .catch(error => {
        list.innerHTML = '';
        const failed = document.createElement('div');
        failed.textContent = 'Could not load order list: ' + error.message;
        Object.assign(failed.style, {
          padding:'16px',
          color:'#b91c1c',
          fontSize:'13px'
        });
        list.appendChild(failed);
      });

    input.addEventListener('input', renderOrders);

    const submitManual = () => {
      const ref = manualInput.value.trim();
      if (!ref) {
        manualInput.focus();
        return;
      }
      loadOrder(ref);
    };

    open.addEventListener('click', submitManual);
    manualInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') submitManual();
    });

    manualRow.append(manualInput, open);
    card.append(heading, help, input, list, manualRow);
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

  if (event.data?.type === 'HCT_PICKUP_TO_REGISTER') {
    const saleId = String(event.data?.saleId || '').trim();
    if (!saleId) return;
    closeSplitOverlay();
    location.assign(
      location.origin + '/redirect/1.0/sales/' + encodeURIComponent(saleId) + '?platform=web'
    );
    return;
  }

  if (event.data?.type === 'HCT_SPLIT_COMPLETE') {
    closeSplitOverlay();
  }
});
 + Number(order.paymentTotal || 0).toFixed(2);
        Object.assign(meta.style, {
          fontSize:'12px',
          color:'#64748b'
        });

        const retrieve = document.createElement('button');
        retrieve.type = 'button';
        retrieve.textContent = 'Retrieve to Register';
        Object.assign(retrieve.style, {
          flex:'0 0 auto',
          padding:'8px 10px',
          border:'1px solid #0f172a',
          borderRadius:'6px',
          background:'#16a34a',
          color:'#fff',
          fontWeight:'800',
          fontSize:'12px',
          cursor:'pointer'
        });

        details.append(titleLine, meta);
        details.addEventListener('click', () => loadOrder(order.invoiceNumber || order.id));
        retrieve.addEventListener('click', () => {
          const saleId = String(order.id || '').trim();
          if (!saleId) return;
          closeSplitOverlay();
          location.assign(
            location.origin + '/redirect/1.0/sales/' + encodeURIComponent(saleId) + '?platform=web'
          );
        });

        row.append(details, retrieve);
        list.appendChild(row);
      }
    };

    fetch(HCT_BACKEND + '/api/work-orders/eligible')
      .then(async response => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Could not load eligible orders.');
        orders = Array.isArray(data.orders) ? data.orders : [];
        renderOrders();
      })
      .catch(error => {
        list.innerHTML = '';
        const failed = document.createElement('div');
        failed.textContent = 'Could not load order list: ' + error.message;
        Object.assign(failed.style, {
          padding:'16px',
          color:'#b91c1c',
          fontSize:'13px'
        });
        list.appendChild(failed);
      });

    input.addEventListener('input', renderOrders);

    const submitManual = () => {
      const ref = manualInput.value.trim();
      if (!ref) {
        manualInput.focus();
        return;
      }
      loadOrder(ref);
    };

    open.addEventListener('click', submitManual);
    manualInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') submitManual();
    });

    manualRow.append(manualInput, open);
    card.append(heading, help, input, list, manualRow);
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
