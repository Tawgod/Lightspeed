const HCT_BACKEND = 'https://lightspeed-api-production-c087.up.railway.app';
const HCT_TIMECLOCK_BACKEND = 'https://timeclock-production-2bfa.up.railway.app';

const hctZipLookupCache = new Map();
let hctZipLookupTimer = null;

async function hctLookupUsZip(zip) {
  const clean = String(zip || '').replace(/\D/g, '').slice(0, 5);
  if (clean.length !== 5) return null;
  if (hctZipLookupCache.has(clean)) return hctZipLookupCache.get(clean);

  const response = await fetch(HCT_BACKEND + '/api/address/zip?zip=' + encodeURIComponent(clean));
  if (!response.ok) return null;
  const data = await response.json();
  const result = data?.city && data?.state ? { city:data.city, state:data.state } : null;

  hctZipLookupCache.set(clean, result);
  return result;
}

function hctFieldDescriptor(el) {
  return [
    el.id,
    el.name,
    el.getAttribute('aria-label'),
    el.getAttribute('placeholder'),
    el.getAttribute('autocomplete')
  ].filter(Boolean).join(' ').toLowerCase();
}

function hctFindAddressField(root, hints) {
  const fields = [...root.querySelectorAll('input')];
  return fields.find(el => {
    const d = hctFieldDescriptor(el);
    return hints.some(hint => d.includes(hint));
  }) || null;
}

function hctSetNativeInputValue(el, value) {
  if (!el || !value) return;
  const proto = Object.getPrototypeOf(el);
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
  if (descriptor?.set) descriptor.set.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles:true }));
  el.dispatchEvent(new Event('change', { bubbles:true }));
}

function ensureCustomerZipAutofill() {
  const inputs = [...document.querySelectorAll('input')];

  for (const zipInput of inputs) {
    if (zipInput.dataset.hctZipAutofill === '1') continue;
    const descriptor = hctFieldDescriptor(zipInput);
    const looksLikeZip =
      descriptor.includes('postal') ||
      descriptor.includes('postcode') ||
      descriptor.includes('zip') ||
      descriptor.includes('postal-code');
    if (!looksLikeZip) continue;

    zipInput.dataset.hctZipAutofill = '1';

    const resolveRoot = () =>
      zipInput.closest('form,[role="dialog"],[data-testid*="customer" i],[class*="customer" i]') ||
      document;

    zipInput.addEventListener('input', () => {
      const clean = String(zipInput.value || '').replace(/\D/g, '').slice(0, 5);
      if (hctZipLookupTimer) clearTimeout(hctZipLookupTimer);
      if (clean.length !== 5) return;

      hctZipLookupTimer = setTimeout(async () => {
        try {
          const place = await hctLookupUsZip(clean);
          if (!place) return;

          const root = resolveRoot();
          const city = hctFindAddressField(root, ['address-level2','city','town']);
          const state = hctFindAddressField(root, ['address-level1','state','province','region']);

          hctSetNativeInputValue(city, place.city);
          hctSetNativeInputValue(state, place.state);
        } catch (error) {
          console.warn('[Hobby Corner] ZIP lookup failed', error);
        }
      }, 200);
    });

    const parent = zipInput.parentElement;
    if (parent && !parent.querySelector('[data-hct-usps-verify="1"]')) {
      const verify = document.createElement('button');
      verify.type = 'button';
      verify.dataset.hctUspsVerify = '1';
      verify.textContent = 'Verify USPS Address';
      Object.assign(verify.style, {
        marginLeft:'8px',
        padding:'7px 10px',
        border:'1px solid #0f766e',
        borderRadius:'6px',
        background:'#0f766e',
        color:'#fff',
        fontWeight:'700',
        cursor:'pointer'
      });

      verify.addEventListener('click', async () => {
        const root = resolveRoot();
        const street = hctFindAddressField(root, ['address-line1','address 1','address1','street address','street']);
        const secondary = hctFindAddressField(root, ['address-line2','address 2','address2','suite','unit','apt']);
        const city = hctFindAddressField(root, ['address-level2','city','town']);
        const state = hctFindAddressField(root, ['address-level1','state','province','region']);

        if (!street?.value?.trim()) {
          alert('Enter the street address first.');
          return;
        }

        const oldText = verify.textContent;
        verify.disabled = true;
        verify.textContent = 'Checking USPS…';

        try {
          const response = await fetch(HCT_BACKEND + '/api/address/verify-usps', {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({
              street_address:street.value.trim(),
              secondary_address:secondary?.value?.trim() || '',
              city:city?.value?.trim() || '',
              state:state?.value?.trim() || '',
              zip:zipInput.value.trim()
            })
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(data.error || 'USPS verification failed.');

          const zipText = data.zip_plus4 ? data.zip + '-' + data.zip_plus4 : data.zip;
          const standardized = [
            data.street_address,
            data.secondary_address,
            [data.city, data.state, zipText].filter(Boolean).join(' ')
          ].filter(Boolean).join(', ');

          if (confirm('USPS standardized address:\n\n' + standardized + '\n\nUse this address?')) {
            hctSetNativeInputValue(street, data.street_address);
            hctSetNativeInputValue(secondary, data.secondary_address || '');
            hctSetNativeInputValue(city, data.city);
            hctSetNativeInputValue(state, data.state);
            hctSetNativeInputValue(zipInput, zipText);
          }
        } catch (error) {
          alert(error.message || 'Could not verify the address with USPS.');
        } finally {
          verify.disabled = false;
          verify.textContent = oldText;
        }
      });

      parent.appendChild(verify);
    }
  }
}


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
ensureTimeclockButton();
ensureCustomerZipAutofill();
new MutationObserver(() => {
  ensurePoLabelButton();
  ensureSplitLauncher();
  ensureTimeclockButton();
  ensureCustomerZipAutofill();
}).observe(document.documentElement, {childList:true, subtree:true});


function formatMinutes(totalMinutes) {
  const minutes = Math.max(0, Number(totalMinutes || 0));
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return hours + 'h ' + remainder + 'm';
}

function findVisibleHeaderHelp() {
  const candidates = [...document.querySelectorAll('button,a,[role="button"],span,div')];
  return candidates.find(el => {
    const text = String(el.textContent || '').trim().toLowerCase();
    if (text !== 'help' && text !== '?') return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.top >= 0 &&
      rect.top < 120 &&
      style.display !== 'none' &&
      style.visibility !== 'hidden'
    );
  }) || null;
}

function positionTimeclockButton(button) {
  const help = findVisibleHeaderHelp();
  if (help?.parentElement) {
    Object.assign(button.style, {
      position:'relative',
      left:'auto',
      right:'auto',
      top:'auto',
      bottom:'auto',
      zIndex:'20',
      margin:'0 8px 0 0',
      padding:'7px 11px',
      boxShadow:'none'
    });

    if (button.parentElement !== help.parentElement || button.nextSibling !== help) {
      help.parentElement.insertBefore(button, help);
    }
    return;
  }

  // Fallback for Lightspeed screens that do not expose a usable Help anchor.
  // This keeps the button near the upper-left account/user area instead of
  // floating at the bottom of the register.
  if (button.parentElement !== document.body) {
    document.body.appendChild(button);
  }
  Object.assign(button.style, {
    position:'fixed',
    left:'18px',
    right:'auto',
    top:'72px',
    bottom:'auto',
    zIndex:'2147483645',
    margin:'0',
    padding:'9px 13px',
    boxShadow:'0 3px 10px rgba(0,0,0,.25)'
  });
}

function ensureTimeclockButton() {
  let button = document.getElementById('hct-timeclock-launcher');

  if (!button) {
    button = document.createElement('button');
    button.id = 'hct-timeclock-launcher';
    button.type = 'button';
    button.textContent = '🕒 Timeclock';
    Object.assign(button.style, {
      borderRadius:'7px',
      border:'1px solid #0f172a',
      background:'#0f766e',
      color:'#fff',
      fontWeight:'800',
      fontSize:'13px',
      lineHeight:'1.2',
      cursor:'pointer',
      whiteSpace:'nowrap'
    });
    button.addEventListener('click', openTimeclockOverlay);
  }

  positionTimeclockButton(button);
}

function detectLightspeedUserName() {
  const selectors = [
    '[data-testid*="user"]',
    '[data-testid*="profile"]',
    '[aria-label*="account" i]',
    '[aria-label*="profile" i]',
    '[aria-label*="user" i]',
    'header button',
    'header [role="button"]',
    'nav button',
    'nav [role="button"]'
  ];

  const candidates = [];
  for (const selector of selectors) {
    for (const el of document.querySelectorAll(selector)) {
      const rect = el.getBoundingClientRect();
      if (
        rect.width <= 0 ||
        rect.height <= 0 ||
        rect.top < 0 ||
        rect.top > 140
      ) continue;

      const aria = String(el.getAttribute('aria-label') || '').trim();
      const title = String(el.getAttribute('title') || '').trim();
      const text = String(el.textContent || '').trim();
      const values = [aria, title, text].filter(Boolean);

      for (const raw of values) {
        const cleaned = raw
          .replace(/^(account|profile|user|signed in as|logged in as)[:\s-]*/i, '')
          .replace(/\s+/g, ' ')
          .trim();

        if (
          cleaned.length >= 2 &&
          cleaned.length <= 80 &&
          /[a-z]/i.test(cleaned) &&
          !/^(help|search|sell|register|notifications?|settings?|menu|more|support)$/i.test(cleaned)
        ) {
          candidates.push(cleaned);
        }
      }
    }
  }

  const likelyFullName = candidates.find(value =>
    /^[A-Za-z][A-Za-z'’-]+(?:\s+[A-Za-z][A-Za-z'’-]+)+$/.test(value)
  );

  return likelyFullName || '';
}

function closeTimeclockOverlay() {
  document.getElementById('hct-timeclock-overlay')?.remove();
}

function openTimeclockOverlay() {
  closeTimeclockOverlay();

  const overlay = document.createElement('div');
  overlay.id = 'hct-timeclock-overlay';
  Object.assign(overlay.style, {
    position:'fixed',
    inset:'0',
    zIndex:'2147483647',
    background:'rgba(15,23,42,.62)',
    display:'flex',
    alignItems:'center',
    justifyContent:'center',
    padding:'24px'
  });

  const card = document.createElement('div');
  Object.assign(card.style, {
    width:'min(520px, 94vw)',
    maxHeight:'88vh',
    overflowY:'auto',
    background:'#fff',
    borderRadius:'12px',
    padding:'20px',
    boxShadow:'0 20px 60px rgba(0,0,0,.4)',
    fontFamily:'Arial,sans-serif'
  });

  const header = document.createElement('div');
  Object.assign(header.style, {
    display:'flex',
    alignItems:'center',
    justifyContent:'space-between',
    gap:'12px',
    marginBottom:'14px'
  });

  const title = document.createElement('h2');
  title.textContent = 'Hobby Corner Timeclock';
  Object.assign(title.style, { margin:'0', fontSize:'21px', color:'#0f172a' });

  const close = document.createElement('button');
  close.textContent = 'Close';
  Object.assign(close.style, {
    border:'1px solid #94a3b8',
    background:'#fff',
    borderRadius:'6px',
    padding:'7px 10px',
    cursor:'pointer',
    fontWeight:'700'
  });
  close.addEventListener('click', closeTimeclockOverlay);

  header.append(title, close);

  const label = document.createElement('label');
  label.textContent = 'Employee name or 4-digit PIN';
  Object.assign(label.style, {
    display:'block',
    fontSize:'12px',
    fontWeight:'800',
    color:'#475569',
    marginBottom:'5px'
  });

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.placeholder = 'Your name or PIN';
  const detectedLightspeedUser = detectLightspeedUserName();
  nameInput.value = detectedLightspeedUser || localStorage.getItem('hct_timeclock_employee_name') || '';
  Object.assign(nameInput.style, {
    width:'100%',
    boxSizing:'border-box',
    padding:'10px 11px',
    border:'1px solid #94a3b8',
    borderRadius:'6px',
    fontSize:'16px'
  });

  const status = document.createElement('div');
  Object.assign(status.style, {
    marginTop:'14px',
    padding:'14px',
    background:'#f8fafc',
    border:'1px solid #e2e8f0',
    borderRadius:'8px',
    color:'#0f172a',
    lineHeight:'1.5'
  });
  status.textContent = detectedLightspeedUser
    ? 'Detected Lightspeed user: ' + detectedLightspeedUser
    : 'Enter your name to load your timeclock.';

  const history = document.createElement('div');
  Object.assign(history.style, {
    marginTop:'12px',
    display:'none',
    color:'#0f172a'
  });

  const action = document.createElement('button');
  action.textContent = 'Load Timeclock';
  Object.assign(action.style, {
    width:'100%',
    marginTop:'12px',
    padding:'12px 16px',
    border:'2px solid #0f172a',
    borderRadius:'7px',
    background:'#2563eb',
    color:'#fff',
    fontSize:'16px',
    fontWeight:'800',
    cursor:'pointer'
  });

  const error = document.createElement('div');
  Object.assign(error.style, {
    minHeight:'18px',
    marginTop:'9px',
    color:'#b91c1c',
    fontSize:'13px'
  });

  let currentStatus = null;

  const employeeIdentifier = () => nameInput.value.trim();

  const render = (data) => {
    currentStatus = data;
    const since = data.clockIn ? new Date(data.clockIn).toLocaleString() : null;
    status.innerHTML =
      '<div style="font-weight:800;font-size:17px;margin-bottom:6px;">' +
      (data.clockedIn ? 'Clocked In' : 'Clocked Out') +
      '</div>' +
      (since ? '<div>Since: ' + since + '</div>' : '') +
      '<div>Today: <strong>' + formatMinutes(data.todayMinutes) + '</strong></div>' +
      '<div>Current pay period: <strong>' + formatMinutes(data.payPeriodMinutes) + '</strong></div>' +
      '<div style="font-size:12px;color:#64748b;margin-top:5px;">' +
      data.payPeriod.start + ' through ' + data.payPeriod.end +
      '</div>';

    const dayFormatter = new Intl.DateTimeFormat('en-US', {
      weekday:'short',
      month:'short',
      day:'numeric',
      timeZone:'UTC'
    });

    const prettyDate = (dateKey) => dayFormatter.format(new Date(dateKey + 'T12:00:00Z'));
    const recentRows = (data.recentDays || []).map(day =>
      '<div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid #e2e8f0;">' +
        '<span>' + prettyDate(day.date) + '</span>' +
        '<strong>' + formatMinutes(day.minutes) + '</strong>' +
      '</div>'
    ).join('');

    const weekRows = (data.weeklySummaries || []).map(week =>
      '<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #e2e8f0;">' +
        '<span>' + (week.current ? 'This week' : prettyDate(week.start) + ' – ' + prettyDate(week.end)) + '</span>' +
        '<strong>' + formatMinutes(week.minutes) + '</strong>' +
      '</div>'
    ).join('');

    history.innerHTML =
      '<div style="font-weight:800;margin:4px 0 6px;">Recent 7 days</div>' +
      '<div style="font-size:13px;">' + recentRows + '</div>' +
      '<div style="font-weight:800;margin:14px 0 6px;">Sunday–Saturday totals</div>' +
      '<div style="font-size:13px;">' + weekRows + '</div>';
    history.style.display = 'block';

    action.textContent = data.clockedIn ? 'Clock Out' : 'Clock In';
    action.style.background = data.clockedIn ? '#b91c1c' : '#16a34a';
  };

  const loadStatus = async () => {
    const identifier = employeeIdentifier();
    if (!identifier) {
      error.textContent = 'Enter your name first.';
      nameInput.focus();
      return;
    }

    if (!/^\\d{4}$/.test(identifier)) localStorage.setItem('hct_timeclock_employee_name', identifier);
    error.textContent = '';
    action.disabled = true;
    status.textContent = 'Loading...';

    try {
      const response = await fetch(
        HCT_TIMECLOCK_BACKEND + '/api/timeclock/status?identifier=' + encodeURIComponent(identifier)
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not load timeclock.');
      render(data);
    } catch (e) {
      status.textContent = 'Timeclock unavailable.';
      error.textContent = e.message;
    } finally {
      action.disabled = false;
    }
  };

  action.addEventListener('click', async () => {
    if (!currentStatus) {
      await loadStatus();
      return;
    }

    const identifier = employeeIdentifier();
    if (!identifier) return;

    error.textContent = '';
    action.disabled = true;
    action.textContent = currentStatus.clockedIn ? 'Clocking out...' : 'Clocking in...';

    try {
      const endpoint = currentStatus.clockedIn ? 'clock-out' : 'clock-in';
      const response = await fetch(HCT_TIMECLOCK_BACKEND + '/api/timeclock/' + endpoint, {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({ identifier })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Timeclock action failed.');
      render(data);
    } catch (e) {
      error.textContent = e.message;
      if (currentStatus) render(currentStatus);
    } finally {
      action.disabled = false;
    }
  });

  nameInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') loadStatus();
  });

  card.append(header, label, nameInput, status, history, action, error);
  overlay.appendChild(card);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) closeTimeclockOverlay();
  });
  document.body.appendChild(overlay);

  if (employeeIdentifier()) loadStatus();
  else setTimeout(() => nameInput.focus(), 0);
}

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
          ' · Payment $' + Number(order.paymentTotal || 0).toFixed(2);
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
