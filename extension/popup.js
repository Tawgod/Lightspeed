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

// One small image per supplier domain, saved only inside this Chrome profile.
// No screenshot is sent to Railway, Lightspeed or a supplier.
async function saveSupplierSnapshot(tab, domain) {
  const raw = await chrome.tabs.captureVisibleTab(tab.windowId, {format:'jpeg',quality:55});
  const image = new Image();
  await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(new Error('Could not load snapshot'));image.src=raw;});
  const scale=Math.min(1,900/image.width,650/image.height);
  const canvas=document.createElement('canvas');
  canvas.width=Math.max(1,Math.floor(image.width*scale));
  canvas.height=Math.max(1,Math.floor(image.height*scale));
  canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);
  const thumbnail=canvas.toDataURL('image/jpeg',0.58);
  if(thumbnail.length>450000)throw new Error('Snapshot too large; try a smaller browser window.');
  const key='supplierSnapshot:'+domain;
  const indexKey='supplierSnapshotDomains';
  const old=await chrome.storage.local.get([indexKey]);
  const domains=[domain,...(Array.isArray(old[indexKey])?old[indexKey]:[]).filter(d=>d!==domain)];
  const evicted=domains.slice(8);
  if(evicted.length)await chrome.storage.local.remove(evicted.map(d=>'supplierSnapshot:'+d));
  await chrome.storage.local.set({[key]:{domain,image:thumbnail,capturedAt:new Date().toISOString()},[indexKey]:domains.slice(0,8)});
}

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
        // Never mistake a supplier's SKU/MPN for the store's general SKU or UPC.
        const digits=v=>String(v??'').replace(/[^0-9]/g,'');
        const validGtin=v=>{const n=digits(v);return [8,12,13,14].includes(n.length)?n:'';};
        const upcCandidates=[p?.gtin12,p?.gtin13,p?.gtin14,p?.gtin8,p?.gtin,p?.upc,meta('product:upc'),meta('product:gtin'),meta('gtin'),(document.querySelector('[itemprop="gtin12"],[itemprop="gtin13"],[itemprop="gtin14"],[itemprop="gtin8"],[itemprop="gtin"]')?.getAttribute('content')||document.querySelector('[itemprop="gtin12"],[itemprop="gtin13"],[itemprop="gtin14"],[itemprop="gtin8"],[itemprop="gtin"]')?.textContent)];
        // ACD displays product values as visible label/value pairs; fall back to
        // these only for acdd.com product pages when metadata omits a field.
        const isAcd=/(^|\.)acdd\.com$/i.test(location.hostname);
        const visible=isAcd?(document.body?.innerText||'').slice(0,150000):'';
        const lines=visible.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
        const allLabels='SKU|UPC|EAN|GTIN|Manufacturer|MSRP|Shipping Weight|Item Weight|Weight|Category|Order By Date|Stock|Quantity';
        const fromLabel=label=>{
          if(!isAcd)return '';
          const re=new RegExp('(?:^|\\s)(?:'+label+')\\s*:\\s*(.*)$','i');
          const nextLabel=new RegExp('\\s+(?:(?:'+allLabels+')\\s*:)','i');
          for(let i=0;i<lines.length;i++){
            const match=lines[i].match(re);
            if(!match)continue;
            let value=match[1].split(nextLabel)[0].trim();
            if(!value&&lines[i+1]&&!new RegExp('^(?:'+allLabels+')\\s*:','i').test(lines[i+1]))value=lines[i+1];
            return value.trim();
          }
          return '';
        };
        const money=value=>{
          const found=String(value||'').match(/(?:\$\s*)?([0-9]+(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)/);
          return found?found[1].replace(/,/g,''):'';
        };
        const acdUpc=validGtin(fromLabel('UPC|EAN|GTIN'));
        const capturedUpc=upcCandidates.map(validGtin).find(Boolean)||acdUpc;
        const acdSupplierSku=fromLabel('SKU');
        const acdManufacturer=fromLabel('Manufacturer');
        const acdMsrp=money(fromLabel('MSRP'));
        const acdWeight=fromLabel('Shipping Weight|Item Weight|Weight').match(/^[0-9]+(?:\.[0-9]+)?\s*(?:lbs?|ounces?|oz|kg|g)?\b/i)?.[0]||'';
        const acdPrice=money((isAcd?visible.match(/(?:^|\n)\s*\$\s*([0-9]+(?:\.[0-9]{2}))/m)?.[1]:null)||'');
        const acdStatus=fromLabel('Category');

        const str=v=>typeof v==='string'?v.trim():'';
        return {sourceUrl:location.href,capturedAt:new Date().toISOString(),candidates:products.length,requiresSelection:products.length>1,product:p?{
          name:str(p.name),description:str(p.description),sku:'',supplierSku:acdSupplierSku||str(p.sku),upc:capturedUpc,
          brand:acdManufacturer||str(typeof p.brand==='string'?p.brand:p.brand?.name),
          imageUrl:str(typeof image==='string'?image:image?.url),advertisedPrice:offer?.price??null,cost:acdPrice,msrp:acdMsrp,weight:acdWeight,supplierName:isAcd?'ACD Distribution':'',availabilityNote:acdStatus
        }:{name:meta('og:title')||document.title,description:meta('og:description')||meta('description'),sku:'',supplierSku:acdSupplierSku,upc:capturedUpc,brand:acdManufacturer,imageUrl:meta('og:image'),advertisedPrice:null,cost:acdPrice,msrp:acdMsrp,weight:acdWeight,supplierName:isAcd?'ACD Distribution':'',availabilityNote:acdStatus}};
      }
    });
    try {
      const url=new URL(tab.url);
      draft.supplierDomain=url.hostname.toLowerCase().replace(/^www\./,'');
      if(document.getElementById('save-supplier-snapshot')?.checked) {
        await saveSupplierSnapshot(tab,draft.supplierDomain);
        draft.snapshotSaved=true;
      }
    }catch(error){
      // Snapshot failures must not prevent read-only scanning.
      draft.snapshotWarning='Optional supplier snapshot was not saved: '+error.message;
    }
    await chrome.storage.local.set({scannerDraft:draft});
    await chrome.windows.create({url:chrome.runtime.getURL('product-scanner/review.html'),type:'popup',width:1400,height:850});
    window.close();
  } catch(e){setStatus('Scanner unavailable: '+e.message);}
});
