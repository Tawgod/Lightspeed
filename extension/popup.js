const BACKEND = 'https://lightspeed-api-production-c087.up.railway.app';

const saleInput = document.getElementById('sale-ref');
const statusEl = document.getElementById('status');
const resultsEl = document.getElementById('results');

function setStatus(text) {
  statusEl.textContent = text || '';
}

function saleRef() {
  return String(saleInput.value || '').trim();
}

async function detectContext() {
  setStatus('Detecting current Lightspeed order...');
  try {
    const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
    if (!tab?.id) throw new Error('No active tab.');
    const context = await chrome.tabs.sendMessage(tab.id, {type:'HCT_GET_CONTEXT'});
    if (context?.saleRef) {
      saleInput.value = context.saleRef;
      setStatus('Detected order ' + context.saleRef + '.');
    } else {
      setStatus('Could not detect an invoice number on this page. Enter it manually.');
    }
  } catch (e) {
    setStatus('Enter the invoice/order number manually.');
  }
}

document.getElementById('detect').addEventListener('click', detectContext);

document.getElementById('split').addEventListener('click', async () => {
  const ref = saleRef();
  if (!ref) return setStatus('Enter an invoice/order number first.');
  try {
    const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
    if (!tab?.id) throw new Error('No active Lightspeed tab.');
    await chrome.tabs.sendMessage(tab.id, {type:'HCT_OPEN_SPLIT', saleRef:ref});
    window.close();
  } catch (e) {
    setStatus('Open a Lightspeed page first, then try again.');
  }
});

document.getElementById('combine').addEventListener('click', async () => {
  const ref = saleRef();
  if (!ref) return setStatus('Enter an invoice/order number first.');
  setStatus('Finding other open orders for this customer...');
  resultsEl.innerHTML = '';
  try {
    const response = await fetch(BACKEND + '/api/work-orders/sales/' + encodeURIComponent(ref) + '/combine-preview');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Preview failed.');

    const orders = data.otherOpenWorkOrders || [];
    resultsEl.innerHTML = '';

    const customer = document.createElement('div');
    customer.className = 'customer';
    customer.textContent = data.customer?.name || 'Customer';
    resultsEl.appendChild(customer);

    if (!orders.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No other open work orders were found for this customer.';
      resultsEl.appendChild(empty);
    } else {
      for (const order of orders) {
        const card = document.createElement('div');
        card.className = 'card';
        const attrs = (order.attributes || []).join(', ') || 'none';
        card.innerHTML =
          '<div><strong>Invoice ' + String(order.invoiceNumber || '') + '</strong></div>' +
          '<div class="meta">' +
          'State: ' + String(order.state || '') +
          ' · Attributes: ' + attrs +
          ' · Lines: ' + String(order.lineCount || 0) +
          ' · Payment: $' + Number(order.paymentTotal || 0).toFixed(2) +
          '</div>';
        resultsEl.appendChild(card);
      }
    }

    const totals = document.createElement('div');
    totals.className = 'totals';
    const p = data.combinedPreview || {};
    totals.textContent =
      'Preview: ' + String(p.saleCount || 0) + ' orders · ' +
      String(p.lineCount || 0) + ' lines · payments $' +
      Number(p.paymentTotal || 0).toFixed(2) +
      '. Merge is preview-only for now.';
    resultsEl.appendChild(totals);

    setStatus(data.combinable ? 'Same-customer work orders found.' : 'No other open order to combine.');
  } catch (e) {
    setStatus('Unable to load combine preview: ' + e.message);
  }
});

detectContext();

document.getElementById('scan-page').addEventListener('click', async () => {
  setStatus('Capturing current product page…');
  try {
    const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
    if (!tab?.id || !/^https?:/.test(tab.url||'')) throw new Error('Open a supplier product page first.');
    const [{result:draft}] = await chrome.scripting.executeScript({
      target:{tabId:tab.id},
      func: () => {
        const meta = k => document.querySelector('meta[property="'+k+'"],meta[name="'+k+'"]')?.content?.trim() || '';
        const products=[];
        const visit=v=>{if(!v||typeof v!=='object')return;if(Array.isArray(v)){v.forEach(visit);return}if([v['@type']].flat().some(t=>typeof t==='string'&&t.toLowerCase()==='product'))products.push(v);if(v['@graph'])visit(v['@graph'])};
        for(const node of document.querySelectorAll('script[type="application/ld+json"]')){try{visit(JSON.parse(node.textContent))}catch{}}
        const p=products.length===1?products[0]:null;
        const offer=Array.isArray(p?.offers)?p.offers[0]:p?.offers;
        const image=Array.isArray(p?.image)?p.image[0]:p?.image;
        const str=v=>typeof v==='string'?v.trim():'';
        return {sourceUrl:location.href,capturedAt:new Date().toISOString(),candidates:products.length,requiresSelection:products.length>1,product:p?{
          name:str(p.name),description:str(p.description),sku:str(p.sku),upc:str(p.gtin12||p.gtin13||p.gtin14||p.gtin8),
          manufacturerPartNumber:str(p.mpn),brand:str(typeof p.brand==='string'?p.brand:p.brand?.name),
          imageUrl:str(typeof image==='string'?image:image?.url),advertisedPrice:offer?.price??null,currency:str(offer?.priceCurrency)
        }:{name:meta('og:title')||document.title,description:meta('og:description')||meta('description'),sku:'',upc:'',manufacturerPartNumber:'',brand:'',imageUrl:meta('og:image'),advertisedPrice:null,currency:''}};
      }
    });
    await chrome.storage.local.set({scannerDraft:draft});
    await chrome.windows.create({url:chrome.runtime.getURL('product-scanner/review.html'),type:'popup',width:1400,height:850});
    window.close();
  } catch(e){setStatus('Scanner unavailable: '+e.message);}
});
