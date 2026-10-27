import {captureSupplierProductPage} from './product-scanner/page-capture.js';
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

let detectedLightspeedTabId=null;
async function findLightspeedTabs() {
  const tabs=await chrome.tabs.query({});
  const ls=tabs.filter(tab=>tab.id&&/^https?:\/\/[^/]+\.retail\.lightspeed\.app\//i.test(tab.url||''));
  return ls.sort((a,b)=>(Number(b.active)-Number(a.active)) || ((b.lastAccessed||0)-(a.lastAccessed||0)));
}
async function resolveLightspeedTab(){
  const active=await chrome.tabs.query({active:true,currentWindow:true});
  const current=active.find(tab=>/^https?:\/\/[^/]+\.retail\.lightspeed\.app\//i.test(tab.url||''));
  if(current) return current;
  const matches=await findLightspeedTabs();
  if(detectedLightspeedTabId)return matches.find(tab=>tab.id===detectedLightspeedTabId)||matches[0]||null;
  return matches[0]||null;
}
async function detectContext() {
  setStatus('Detecting the open Lightspeed order…');
  try {
    const tab=await resolveLightspeedTab();
    if(!tab)throw new Error('Open an order in Lightspeed Retail first.');
    detectedLightspeedTabId=tab.id;
    let context;
    try {
      context=await chrome.tabs.sendMessage(tab.id,{type:'HCT_GET_CONTEXT'});
    }catch{
      // When Lightspeed hasn't loaded our content script (e.g. after a recent
      // extension update), attempt a read-only DOM check instead of failing.
      const [probe]=await chrome.scripting.executeScript({target:{tabId:tab.id},func:()=>{
        const text=String(document.body?.innerText||'').slice(0,15000);
        const heading=[...document.querySelectorAll('h1,h2,h3')].map(x=>x.textContent||'').join('\n');
        const pattern=/(?:invoice|sale)\s*(?:number|no\.?)?\s*[#:]?\s*([0-9]{1,12})\b/i;
        const found=heading.match(pattern)||text.match(pattern);
        const uuid=location.pathname.match(/\/(?:redirect\/1\.0\/)?sales?\/([0-9a-f-]{36})(?:[/?#]|$)/i);
        const po=location.pathname.match(/\/inventory\/purchase-order\/([^/?#]+)/i);
        return {saleRef:found?.[1]||uuid?.[1]||'',purchaseOrderId:po?.[1]||null};
      }});
      context=probe?.result;
    }
    if(context?.saleRef){
      saleInput.value=context.saleRef;
      setStatus('Detected Lightspeed sale/invoice '+context.saleRef+'.');
    }else if(context?.purchaseOrderId){
      setStatus('Detected purchase order '+context.purchaseOrderId+'. The invoice field is for customer sales; PO Companion is separate.');
    }else{
      setStatus('Lightspeed tab located, but no sale number found. You can enter the invoice number manually.');
    }
  }catch(error){
    setStatus(error.message||'Unable to detect order. Enter invoice number manually.');
  }
}

document.getElementById('detect').addEventListener('click', detectContext);

document.getElementById('split').addEventListener('click', async () => {
  const ref = saleRef();
  if (!ref) return setStatus('Enter an invoice/order number first.');
  try {
    const tab=await resolveLightspeedTab();
    if (!tab?.id) throw new Error('No open Lightspeed tab.');
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
      func: captureSupplierProductPage
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

document.getElementById('po-select').addEventListener('click',async()=>{
 try{
  const tab=await resolveLightspeedTab();
  if(!tab?.id)throw new Error('Open a Lightspeed purchase order first.');
  const context=await chrome.tabs.sendMessage(tab.id,{type:'HCT_GET_CONTEXT'});
  const poId=context?.purchaseOrderId;
  if(!poId || !/^[a-z0-9_-]{1,100}$/i.test(poId))throw new Error('No recognized PO on the Lightspeed tab.');
  await chrome.storage.local.set({poCompanionContext:{poId,selectedAt:new Date().toISOString(),supplierId:null}});
  setStatus('Selected PO '+poId+'. Open the supplier website to view the development panel.');
 }catch(e){setStatus('PO selection: '+e.message);}
});
document.getElementById('po-launch').addEventListener('click',async()=>{
 try{
  const {poCompanionContext:context}=await chrome.storage.local.get('poCompanionContext');
  if(!context?.poId)throw new Error('Select a Lightspeed purchase order first.');
  const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
  const url=new URL(tab?.url||'');
  if(url.protocol!=='https:'||url.hostname.endsWith('.retail.lightspeed.app'))throw new Error('Open an HTTPS supplier website first.');
  await chrome.scripting.executeScript({target:{tabId:tab.id},files:['po-companion/panel.js']});
  window.close();
 }catch(e){setStatus('PO Companion: '+e.message);}
});
