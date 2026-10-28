import {installHobbyCornerNavigation} from '../shared-ui/navigation.mjs';
import {checkProductMatches,toSpecialOrderMatchRequest} from './special-orders-adapter.js';
import {captureSupplierProductPage} from './page-capture.js';
import {productCompleteness} from './completeness.js';
import {copyHobbyCornerField} from '../shared-ui/clipboard.mjs';


// Keep PIN and signed session strictly in this review window's memory.
// Never write credentials to extension storage or send them to suppliers.
const SCANNER_API='https://special-orders-test-production.up.railway.app/api/scanner';
const signInForm=document.getElementById('employee-sign-in');
const pinField=document.getElementById('employee-pin');
const employeeStatus=document.getElementById('employee-status');
const signInButton=document.getElementById('sign-in');
const signOutButton=document.getElementById('sign-out');
let scannerSession=null;
let draftAvailable=false;
let supplierRecords=[];
let supplierVerifiedId=null;
let supplierMatched=false;
let lookupGeneration=0;
let employeeEditedGeneralSku=false;
let capturedSupplierSku='';
let lookupBusy=false;
let pendingLookup=false;
let proposalSourceUrl='';
let proposalRequiresSelection=false;
const submitProposalButton=document.getElementById('submit-product-proposal');
const proposalStatus=document.getElementById('product-proposal-status');
const proposalList=document.getElementById('product-proposal-list');
function setProposalEligibility(){
  submitProposalButton.disabled=!(scannerSession && scannerSession.expiresAt>Date.now() &&
    draftAvailable && !proposalRequiresSelection && supplierMatched &&
    Array.isArray(lastMatches) && lastMatches.length===0 &&
    verifiedProductSignature && verifiedProductSignature===signature());
}
async function loadProductProposals(){
  if(!scannerSession || scannerSession.expiresAt<=Date.now()){proposalList.textContent='Sign in to view proposed items.';return;}
  proposalList.textContent='Loading…';
  try{
    const response=await fetch(SCANNER_API+'/product-proposals',{cache:'no-store',headers:{Authorization:'Bearer '+scannerSession.token}});
    if(!response.ok)throw new Error('Could not load product review queue ('+response.status+').');
    const data=await response.json();
    proposalList.replaceChildren();
    if(!data.proposals?.length){proposalList.textContent='No pending product proposals.';return;}
    let testEnabled=false;
    try{
      const capability=await fetch(SCANNER_API+'/product-test-creation/status',{
        cache:'no-store',headers:{Authorization:'Bearer '+scannerSession.token}});
      if(capability.ok)testEnabled=(await capability.json()).enabled===true;
    }catch{}
    for(const entry of data.proposals){
      const item=document.createElement('div');
      item.className='hc-review-item';
      const summary=document.createElement('p');
      summary.textContent=(entry.product_name||'Product')+' · '+(entry.product_sku||entry.supplier_sku||'No SKU')+' · '+(entry.status||'PENDING_REVIEW')+' · Submitted '+new Date(entry.submitted_at).toLocaleString();
      item.append(summary);
      if(entry.status==='PENDING_REVIEW'){
        const action=document.createElement('button');
        action.type='button';
        action.textContent=testEnabled?'Create in Isolated Test Store':'Test creation unavailable';
        action.disabled=!testEnabled;
        if(testEnabled)action.addEventListener('click',async()=>{
          if(!window.confirm('Create this product in the isolated Lightspeed TEST store? This will not create it in the live store.'))return;
          action.disabled=true;
          proposalStatus.textContent='Checking duplicates and testing product creation…';
          try{
            const response=await fetch(SCANNER_API+'/product-proposals/'+entry.id+'/test-create',{
              method:'POST',cache:'no-store',
              headers:{'Content-Type':'application/json',Authorization:'Bearer '+scannerSession.token},
              body:JSON.stringify({confirmation:'CREATE TEST PRODUCT',expectedSku:entry.product_sku||entry.supplier_sku||''})
            });
            const answer=await response.json().catch(()=>({}));
            if(!response.ok)throw Error(answer.error||'Test creation could not be verified ('+response.status+').');
            proposalStatus.textContent='Created test product '+(answer.product?.sku||'')+' in the isolated store. Live Lightspeed unchanged.';
            await loadProductProposals();
          }catch(error){proposalStatus.textContent=error.message;}
        });
        item.append(action);
      }
      proposalList.append(item);
    }
  }catch(error){proposalList.textContent=error.message;}
}
document.getElementById('refresh-product-proposals').addEventListener('click',loadProductProposals);
submitProposalButton.addEventListener('click',async()=>{
  if(submitProposalButton.disabled)return;
  const snapshot=signature();
  const supplierId=supplierVerifiedId;
  const product=currentProduct();
  const sourceUrl=proposalSourceUrl;
  submitProposalButton.disabled=true;
  proposalStatus.textContent='Rechecking duplicates and submitting review request…';
  try{
    const response=await fetch(SCANNER_API+'/product-proposals',{
      method:'POST',cache:'no-store',
      headers:{'Content-Type':'application/json',Authorization:'Bearer '+scannerSession.token},
      body:JSON.stringify({supplierId,product,sourceUrl})
    });
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(data.error||'Unable to submit proposal ('+response.status+').');
    proposalStatus.textContent='Submitted '+product.name+' for review. No product was created in Lightspeed.';
    await loadProductProposals();
  }catch(error){proposalStatus.textContent=error.message;}
  if(snapshot===signature())setProposalEligibility();
});

const SUPPLIER_DOMAINS={'acdd.com':['ACD Distribution','ACD']};
function normalizedSupplierName(value){return String(value||'').toLowerCase().replace(/[^a-z0-9]/g,'');}
function chosenSupplierId(){const name=normalizedSupplierName(supplierInput.value);const exact=supplierRecords.filter(s=>normalizedSupplierName(s.name)===name);return exact.length===1?exact[0].id:null;}
function resolveSupplier(){
  supplierVerifiedId=chosenSupplierId();supplierMatched=!!supplierVerifiedId;
  supplierVerification.textContent=supplierMatched?'Matched existing supplier: '+supplierRecords.find(x=>x.id===supplierVerifiedId).name:'⚠ No exact supplier match. Review or choose an existing supplier before proposing creation.';
  supplierVerification.style.color=supplierMatched?'#2d8053':'#b56309';
}
async function lookupSuppliers(){
  if(!scannerSession||scannerSession.expiresAt<=Date.now())return;
  try{
    const response=await fetch(SCANNER_API+'/suppliers',{headers:{Authorization:'Bearer '+scannerSession.token},cache:'no-store'});
    if(!response.ok)throw new Error('Supplier lookup failed ('+response.status+')');
    const result=await response.json();
    supplierRecords=Array.isArray(result.suppliers)?result.suppliers:[];
    const list=document.getElementById('supplier-options');list.replaceChildren();
    for(const supplier of supplierRecords){const option=document.createElement('option');option.value=supplier.name;list.append(option);}
    const aliases=SUPPLIER_DOMAINS[sourceDomain]||[];
    const suggestion=supplierInput.value.trim();
    const exact=supplierRecords.find(x=>normalizedSupplierName(x.name)===normalizedSupplierName(suggestion));
    if(!exact){
      const candidates=supplierRecords.filter(x=>aliases.some(alias=>normalizedSupplierName(x.name)===normalizedSupplierName(alias)));
      if(candidates.length===1)supplierInput.value=candidates[0].name;
    }
    resolveSupplier();
  }catch(error){supplierRecords=[];resolveSupplier();supplierVerification.textContent='⚠ Supplier records could not be verified. '+error.message;}
}


function clearScannerSession(){
  scannerSession=null;
  pinField.value='';
  signOutButton.hidden=true;
  signInForm.hidden=false;
  signInButton.disabled=false;
  signInButton.hidden=false;
  pinField.disabled=false;
  checkButton.disabled=true;
  lookupGeneration++;pendingLookup=false;createButton.disabled=true;stagePreorderButton.disabled=true;submitProposalButton.disabled=true;
  employeeStatus.textContent='Not signed in. Use your Timeclock PIN.';
}
signOutButton.addEventListener('click',clearScannerSession);
signInForm.addEventListener('submit',async event=>{
  event.preventDefault();
  const pin=pinField.value;
  if(!/^\d{4}$/.test(pin)){
    employeeStatus.textContent='Enter your four-digit Timeclock PIN.';
    pinField.value='';
    return;
  }
  signInButton.disabled=true;
  employeeStatus.textContent='Verifying employee…';
  try {
    const response=await fetch(SCANNER_API+'/session',{
      method:'POST',cache:'no-store',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({pin})
    });
    if(!response.ok)throw new Error(response.status===429
      ? 'Too many sign-in attempts. Try again later.'
      : response.status===404||response.status===503
        ? 'Scanner sign-in is not active on Railway yet.'
        : 'PIN not recognized or scanner access denied.');
    const data=await response.json();
    if(!data?.token || !Number.isFinite(data.expiresIn) || data.expiresIn<=0 || data.employee?.canLookup!==true){
      throw new Error('Scanner sign-in returned an invalid session.');
    }
    scannerSession={token:data.token,expiresAt:Date.now()+data.expiresIn*1000,canApprove:data.employee.canApprove===true};
    pinField.disabled=true;
    signInButton.hidden=true;
    signOutButton.hidden=false;
    const role=data.employee.role?' ('+data.employee.role+')':'';
    const reasons={lightspeed_account_not_linked:'No Lightspeed user link was found for this PIN.',lightspeed_user_not_found:'The linked Lightspeed account could not be found.',lightspeed_role_not_recognized:'The Lightspeed role could not be verified.',lightspeed_lookup_unavailable:'Lightspeed permissions could not be checked.',role_read_only:'Lightspeed returned a read-only role.'};
    employeeStatus.textContent='Signed in as '+(data.employee.name||'employee')+'. '+(data.employee.canApprove===true?'Scanner review access enabled. Live product writes remain separately protected.':'Scanner access restricted: '+(reasons[data.employee.permissionReason]||'Employee authorization pending.'));
    checkButton.disabled=!draftAvailable;
    await lookupSuppliers();
    if(preorderCheckbox.checked)await loadPreorderCampaigns();
    if(draftAvailable)queueProductLookup();
  }catch(error){
    scannerSession=null;
    employeeStatus.textContent=error.message;
  }finally{
    pinField.value='';
    signInButton.disabled=false;
  }
});

const keys=['name','sku','supplierSku','upc','brand','cost','msrp','weight','imageUrl','mapPrice'];
const labels={name:'Product name',sku:'General SKU (Lightspeed)',supplierSku:'Supplier reorder number',upc:'UPC / GTIN',brand:'Manufacturer / Brand',cost:'Supplier Cost (reference)',msrp:'MSRP (reference)',weight:'Weight (with unit)',imageUrl:'Image URL',mapPrice:'MAP price (verify with supplier)'};
const status=document.getElementById('status');
const matchStatus=document.getElementById('match-status');
const matchesElement=document.getElementById('matches');
const checkButton=document.getElementById('check-matches');
const createButton=document.getElementById('create-item');
const createPreview=document.getElementById('create-preview');

const preorderCheckbox=document.getElementById('add-to-preorder');
const preorderOptions=document.getElementById('preorder-options');
const preorderSelect=document.getElementById('preorder-campaign');
const preorderStatus=document.getElementById('preorder-status');
const stagePreorderButton=document.getElementById('stage-preorder');
let campaignsLoaded=false;
let verifiedCampaigns=[];
function stageEligibility(){
  const approved=!!scannerSession && scannerSession.expiresAt>Date.now() && scannerSession.canApprove===true;
  const valid=approved && !!verifiedProductSignature && verifiedProductSignature===signature() &&
    Array.isArray(lastMatches) && supplierMatched;
  stagePreorderButton.disabled=!(preorderCheckbox.checked&&preorderSelect.value&&valid);
}
async function loadPreorderCampaigns(){
  preorderSelect.replaceChildren();
  const placeholder=document.createElement('option');placeholder.value='';placeholder.textContent='Select an existing campaign';preorderSelect.append(placeholder);
  if(!scannerSession||scannerSession.expiresAt<=Date.now()){preorderStatus.textContent='Sign in to load campaigns.';return;}
  preorderStatus.textContent='Loading available campaigns…';
  try{
    const response=await fetch(SCANNER_API+'/preorder-campaigns',{headers:{Authorization:'Bearer '+scannerSession.token},cache:'no-store'});
    if(!response.ok)throw new Error('Could not retrieve campaigns ('+response.status+').');
    const result=await response.json();
    verifiedCampaigns=Array.isArray(result.campaigns)?result.campaigns:[];
    for(const c of verifiedCampaigns){
      const option=document.createElement('option');option.value=String(c.id);option.textContent=String(c.name||'Campaign').slice(0,130);preorderSelect.append(option);
    }
    campaignsLoaded=true;
    preorderStatus.textContent=verifiedCampaigns.length
      ? 'Select a campaign; items stay pending review until separately approved.'
      : 'No open preorder campaigns found.';
  }catch(error){verifiedCampaigns=[];campaignsLoaded=false;preorderStatus.textContent=error.message;}
  stageEligibility();
}
preorderCheckbox.addEventListener('change',()=>{
  preorderOptions.hidden=!preorderCheckbox.checked;
  if(preorderCheckbox.checked)loadPreorderCampaigns();
  stageEligibility();
});
async function refreshStagedItems(){
  const panel=document.getElementById('preorder-queued-list');
  panel.replaceChildren();
  if(!preorderSelect.value||!scannerSession)return;
  try{
    const response=await fetch(SCANNER_API+'/preorder-campaigns/'+encodeURIComponent(preorderSelect.value)+'/staged',{
      headers:{Authorization:'Bearer '+scannerSession.token},cache:'no-store'
    });
    if(!response.ok)throw new Error('Staged items could not be loaded.');
    const result=await response.json();
    const title=document.createElement('strong');
    title.textContent=(result.items?.length||0)+' items staged for review';
    panel.append(title);
    for(const item of (result.items||[]).slice(0,10)){
      const row=document.createElement('p');
      row.textContent=(item.item_name||'Product')+(item.sku?' — '+item.sku:'')+' ('+(item.status||'pending')+')';
      panel.append(row);
    }
  }catch(error){panel.textContent=error.message;}
}
preorderSelect.addEventListener('change',()=>{stageEligibility();refreshStagedItems();});
stagePreorderButton.addEventListener('click',async()=>{
  if(stagePreorderButton.disabled||!preorderCheckbox.checked)return;
  stagePreorderButton.disabled=true;
  if(!scannerSession || scannerSession.expiresAt<=Date.now() || !scannerSession.canApprove){
    preorderStatus.textContent='Active Timeclock employee sign-in required. Sign in again.';return;
  }
  if(!verifiedProductSignature||verifiedProductSignature!==signature()||!Array.isArray(lastMatches)||!supplierMatched){
    preorderStatus.textContent='Product and supplier must pass duplicate verification before staging.';stageEligibility();return;
  }
  const campaign=verifiedCampaigns.find(c=>String(c.id)===preorderSelect.value);
  if(!campaign){preorderStatus.textContent='Select a valid existing campaign.';return;}
  const draft=(await chrome.storage.local.get('scannerDraft')).scannerDraft;
  try{
    const response=await fetch(SCANNER_API+'/preorder-campaigns/'+encodeURIComponent(preorderSelect.value)+'/staged',{
      method:'POST',cache:'no-store',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+scannerSession.token},
      body:JSON.stringify({supplierId:supplierVerifiedId,product:currentProduct(),sourceUrl:draft?.sourceUrl||''})
    });
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(data.error||'Could not stage item ('+response.status+').');
    preorderStatus.textContent='Staged '+(data.item?.name||'product')+' for review in '+campaign.name+'. Nothing posted to Discord.';
    await refreshStagedItems();
  }catch(error){preorderStatus.textContent=error.message;}
  stageEligibility();
});


const supplierInput=document.getElementById('supplier-default');
const supplierVerification=document.getElementById('supplier-verification');
const snapshotPanel=document.getElementById('supplier-snapshot-panel');
const snapshotInput=document.getElementById('supplier-image-upload');
const snapshotStatus=document.getElementById('supplier-snapshot-status');
const snapshotPreview=document.getElementById('supplier-snapshot-preview');
let sourceDomain='';
function snapshotKey(){return sourceDomain?'supplierSnapshot:'+sourceDomain:null;}
async function refreshSupplierSnapshot(){
  const key=snapshotKey();
  if(!key){snapshotStatus.textContent='No supplier website associated with this scan.';snapshotPreview.hidden=true;return;}
  const record=(await chrome.storage.local.get(key))[key];
  if(record?.domain===sourceDomain && /^data:image\/jpeg;base64,/.test(record.image||'')){
    snapshotPreview.src=record.image;
    snapshotPreview.hidden=false;
    snapshotStatus.textContent='Saved locally for '+sourceDomain+' on '+new Date(record.capturedAt).toLocaleDateString()+'.';
  }else{
    snapshotPreview.removeAttribute('src');snapshotPreview.hidden=true;
    snapshotStatus.textContent='No saved snapshot for this supplier website.';
  }
}
snapshotInput.addEventListener('change',async()=>{
  const file=snapshotInput.files?.[0];
  if(!file)return;
  if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>8*1024*1024){
    snapshotStatus.textContent='Use a JPG, PNG or WebP image under 8 MB.';snapshotInput.value='';return;
  }
  if(!snapshotKey()){snapshotStatus.textContent='Scan a supplier page before uploading a template reference.';return;}
  try{
    const objectUrl=URL.createObjectURL(file);
    const image=new Image();
    try{
      await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(new Error('Invalid image'));image.src=objectUrl;});
      const scale=Math.min(1,900/image.width,650/image.height);
      const canvas=document.createElement('canvas');
      canvas.width=Math.max(1,Math.floor(image.width*scale));
      canvas.height=Math.max(1,Math.floor(image.height*scale));
      canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);
      const data=canvas.toDataURL('image/jpeg',0.58);
      if(data.length>450000)throw new Error('Snapshot is too large after resizing');
      const indexKey='supplierSnapshotDomains';
      const old=await chrome.storage.local.get(indexKey);
      const domains=[sourceDomain,...(Array.isArray(old[indexKey])?old[indexKey]:[]).filter(d=>d!==sourceDomain)];
      if(domains.length>8)await chrome.storage.local.remove(domains.slice(8).map(d=>'supplierSnapshot:'+d));
      await chrome.storage.local.set({[snapshotKey()]:{domain:sourceDomain,image:data,capturedAt:new Date().toISOString()},[indexKey]:domains.slice(0,8)});
      await refreshSupplierSnapshot();
    }finally{URL.revokeObjectURL(objectUrl);}
  }catch(error){snapshotStatus.textContent='Could not save snapshot: '+error.message;}
  finally{snapshotInput.value='';}
});
document.getElementById('remove-supplier-snapshot').addEventListener('click',async()=>{
  const key=snapshotKey();if(!key)return;
  await chrome.storage.local.remove(key);
  const old=await chrome.storage.local.get('supplierSnapshotDomains');
  await chrome.storage.local.set({supplierSnapshotDomains:(old.supplierSnapshotDomains||[]).filter(d=>d!==sourceDomain)});
  await refreshSupplierSnapshot();
});

let verifiedProductSignature=null;
let lastMatches=null;
function signature(){return JSON.stringify({...currentProduct(),supplier:supplierInput.value.trim()});}
supplierInput.addEventListener('input',()=>{invalidateVerification();resolveSupplier();queueProductLookup();});
function invalidateVerification(){submitProposalButton.disabled=true;stagePreorderButton.disabled=true;lookupGeneration++;verifiedProductSignature=null;lastMatches=null;createButton.disabled=true;createPreview.hidden=true;matchStatus.textContent='Product changed — checking for existing products…';}

function currentProduct(){
  const product=Object.fromEntries(keys.map(k=>[k,document.getElementById('field-'+k).value.trim()]));
  product.description=document.getElementById('description').value.trim();
  return product;
}
function matchingLightspeedSku(matches,product){
  const normalized=x=>String(x||'').trim().toLowerCase();
  const upc=String(product.upc||'').replace(/\D/g,'');
  // Do not change SKU based on fuzzy name results. Require exact UPC or
  // supplier reorder number, and a single unambiguous linked product.
  const exact=matches.filter(m=>{
    const code=String(m.upc||'').replace(/\D/g,'');
    return (upc&&code&&upc===code) ||
      (product.supplierSku&&m.supplierSku&&normalized(m.supplierSku)===normalized(product.supplierSku)) ||
      (product.sku&&normalized(m.sku)===normalized(product.sku));
  });
  const distinct=new Map(exact.filter(m=>m.lightspeedId && m.sku).map(m=>[String(m.lightspeedId),m]));
  return distinct.size===1?[...distinct.values()][0].sku:null;
}
function showMatches(matches){
  matchesElement.replaceChildren();
  if(!matches.length){matchesElement.textContent='No potential products found in either matching service.';return;}
  for(const match of matches){
    const box=document.createElement('div');box.className='card';
    const title=document.createElement('strong');title.textContent=match.name||'(Unnamed product)';
    const desc=document.createElement('p');desc.textContent='SKU: '+(match.sku||'Missing')+' · Description: '+(match.description||'Missing');
    const {missing,unknown}=productCompleteness(match);
    const alert=document.createElement('p');
    alert.className=missing.length?'missing':'complete';
    alert.textContent=missing.length?'Missing: '+missing.join(', '):'No confirmed missing fields';
    if(unknown.length)alert.textContent+=' · Not verified: '+unknown.join(', ');
    box.append(title,desc,alert);
    matchesElement.append(box);
  }
}

function loadScannerDraft(d){
  verifiedProductSignature=null;lastMatches=null;createButton.disabled=true;stagePreorderButton.disabled=true;submitProposalButton.disabled=true;createPreview.hidden=true;matchesElement.replaceChildren();
  document.getElementById('fields').replaceChildren();
  proposalSourceUrl=d?.sourceUrl||'';
  proposalRequiresSelection=d?.requiresSelection===true;
  draftAvailable=false;
  if(!d){status.textContent='No product has been captured. Use Scan Current Page in the extension.';checkButton.disabled=true;return;}
  if(d.requiresSelection){
    status.textContent='Multiple products detected. Open one individual product page.';
    matchStatus.textContent='No matching or new-item proposal allowed from a multi-product page.';
    document.getElementById('warnings').textContent='Scan a single supplier product page, not a catalog.';
    checkButton.disabled=true;
    return;
  }
  status.textContent='Review extracted information; no changes have been sent to Lightspeed.';
  draftAvailable=true;
  employeeEditedGeneralSku=false;
  const p=d.product||{};
  capturedSupplierSku=String(p.supplierSku??p.sku??'').trim();
  sourceDomain=String(d.supplierDomain||'').trim().toLowerCase();
  supplierInput.value=String(p.supplierName||SUPPLIER_DOMAINS[sourceDomain]?.[0]||sourceDomain||'').trim();
  supplierVerification.textContent=p.supplierName
    ? 'Supplier detected from site: verify this matches an existing supplier before approval.'
    : 'Suggested from website domain only. Enter the actual supplier name and verify against existing suppliers.';
  if(d.snapshotWarning)snapshotStatus.textContent=d.snapshotWarning;
  refreshSupplierSnapshot().catch(error=>{snapshotStatus.textContent='Snapshot unavailable: '+error.message;});
  if(/^https?:\/\//.test(d.sourceUrl||'')){document.getElementById('source').href=d.sourceUrl;}
  document.getElementById('source').textContent=d.sourceUrl?'Source page':'Source unavailable';
  const fields=document.getElementById('fields');
  for(const k of keys){const label=document.createElement('label');label.textContent=labels[k];const input=document.createElement('input');input.id='field-'+k;
    input.value=k==='supplierSku' ? capturedSupplierSku : k==='sku' ? (p.sku||capturedSupplierSku) : (p[k]??'');
    input.addEventListener('input',()=>{
      if(k==='sku')employeeEditedGeneralSku=true;
      if(k==='supplierSku'&&!employeeEditedGeneralSku){
        const skuInput=document.getElementById('field-sku');
        if(skuInput && skuInput.value.trim()===capturedSupplierSku)skuInput.value=input.value;
        capturedSupplierSku=input.value.trim();
      }
      invalidateVerification();queueProductLookup();
    });label.append(input);fields.append(label);}
  document.getElementById('description').value=p.description||'';
  document.getElementById('description').addEventListener('input',()=>{invalidateVerification();queueProductLookup();});
  const missing=['name','upc'].filter(k=>!p[k]);
  if(p.availabilityNote)document.getElementById('supplier-status').textContent='Supplier listing: '+p.availabilityNote+' (confirm availability before ordering).';
  if(p.supplierName)document.getElementById('supplier-name').textContent='Supplier: '+p.supplierName;
  document.getElementById('warnings').textContent=missing.length?'Not found on supplier page — enter or verify manually: '+missing.join(', ')+'. General SKU defaults to the supplier reorder number unless an exact Lightspeed match is found.':'';
  checkButton.disabled=!scannerSession || scannerSession.expiresAt<=Date.now();
  if(scannerSession){lookupSuppliers().then(()=>queueProductLookup());}
}
chrome.storage.local.get('scannerDraft',({scannerDraft:d})=>loadScannerDraft(d));
document.getElementById('copy').addEventListener('click',async()=>{
  try{await copyHobbyCornerField({plainText:JSON.stringify(currentProduct(),null,2)});status.textContent='Proposed data copied. No Lightspeed changes made.';}
  catch(e){status.textContent='Clipboard failed: '+e.message;}
});

async function checkExistingProducts(){
  if(!scannerSession||scannerSession.expiresAt<=Date.now()){
    matchStatus.textContent='Sign in to check existing products.';createButton.disabled=true;return;
  }
  if(!draftAvailable)return;
  const generation=++lookupGeneration;
  lookupBusy=true;checkButton.disabled=true;createButton.disabled=true;createPreview.hidden=true;
  verifiedProductSignature=null;lastMatches=null;matchStatus.textContent='Checking existing products…';matchesElement.replaceChildren();
  const currentSignature=signature();
  try{
    const product=currentProduct();
    // Search all supplier associations, not just the selected supplier, to avoid duplicate products.
    const body=toSpecialOrderMatchRequest(product);
    const response=await fetch(SCANNER_API+'/matches',{
      method:'POST',cache:'no-store',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+scannerSession.token},
      body:JSON.stringify(body)
    });
    if(!response.ok)throw new Error(response.status===401||response.status===403?'Sign in again to check products.':'Product verification failed ('+response.status+').');
    const data=await response.json();
    if(data?.verified!==true||!Array.isArray(data.local?.matches)||!Array.isArray(data.remote?.matches))throw new Error('Incomplete matching results');
    const result=await checkProductMatches(product,async kind=>kind==='local'?data.local:data.remote);
    if(generation!==lookupGeneration||currentSignature!==signature())return;
    showMatches(result.matches);
    if(!employeeEditedGeneralSku){
      const matchedSku=matchingLightspeedSku(result.matches,product);
      const skuField=document.getElementById('field-sku');
      if(matchedSku&&skuField&&matchedSku!==skuField.value)skuField.value=matchedSku;
    }
    verifiedProductSignature=signature();lastMatches=result.matches;
    createButton.disabled=result.matches.length!==0||!supplierMatched;
    stageEligibility();
    setProposalEligibility();
    matchStatus.textContent=result.matches.length
      ? result.matches.length+' potential product match(es). Review missing information below.'
      : supplierMatched?'No existing products matched. You can prepare a new-item proposal.':'No product matched, but supplier selection needs review.';
  }catch(error){
    if(generation===lookupGeneration)matchStatus.textContent='Unable to verify existing products: '+error.message;
  }finally{
    lookupBusy=false;checkButton.disabled=false;
    if(pendingLookup){pendingLookup=false;queueProductLookup();}
  }
}
let lookupDelay=null;
function queueProductLookup(){
  if(lookupDelay)clearTimeout(lookupDelay);
  if(!scannerSession||!draftAvailable)return;
  if(lookupBusy){pendingLookup=true;return;}
  lookupDelay=setTimeout(()=>{lookupDelay=null;checkExistingProducts();},250);
}
checkButton.addEventListener('click',()=>{if(lookupDelay)clearTimeout(lookupDelay);lookupDelay=null;checkExistingProducts();});

// Prepare a proposed new item only after both independent match services succeed.
// This button never posts product writes or calls Lightspeed create endpoints.
createButton.addEventListener('click',()=>{
  if(!scannerSession || scannerSession.expiresAt<=Date.now()){
    invalidateVerification();createPreview.hidden=false;createPreview.textContent='Session expired. Sign in and re-check products.';return;
  }
  if(!verifiedProductSignature || verifiedProductSignature!==signature() || !Array.isArray(lastMatches) || lastMatches.length){
    invalidateVerification();createPreview.hidden=false;createPreview.textContent='Re-check the current product before preparing creation.';return;
  }
  const product=currentProduct();
  if(!supplierMatched){createPreview.hidden=false;createPreview.textContent='Choose a verified existing supplier before preparing a new product. Unmatched suppliers need an administrator review.';return;}
  if(!product.name || (!product.upc && !product.sku && !product.supplierSku)){
    createPreview.hidden=false;createPreview.textContent='Enter a product name and at least one identifier first.';return;
  }
  createPreview.hidden=false;
  createPreview.textContent='Create Item — approval preview only. No Lightspeed changes will be made.\\n'+
    JSON.stringify({supplierSuggestion:supplierInput.value.trim(),supplierWebsite:sourceDomain,supplierVerified:true,name:product.name,generalSku:product.sku,supplierReorderNumber:product.supplierSku,upc:product.upc,brand:product.brand,description:product.description,mapPrice:product.mapPrice,cost:product.cost,msrp:product.msrp,weight:product.weight},null,2)+
    '\\nCreation requires a separately approved, employee-authorized backend workflow.';
});

// Work from an existing supplier tab without closing the scanner review popup.
// Request site access explicitly on click; do not silently read unrelated tabs.
const supplierTabSelect=document.getElementById('supplier-tab');
const scanOpenButton=document.getElementById('scan-open-supplier');
async function supplierTabs(){
  const tabs=await chrome.tabs.query({});
  const eligible=tabs.filter(tab=>{
    if(!Number.isInteger(tab.id)||!/^https?:\/\//i.test(tab.url||''))return false;
    try{
      const host=new URL(tab.url).hostname;
      return !/(^|\.)retail\.lightspeed\.app$/i.test(host);
    }catch{return false;}
  });
  const previous=supplierTabSelect.value;
  supplierTabSelect.replaceChildren();
  for(const tab of eligible){
    const option=document.createElement('option');
    option.value=String(tab.id);
    option.textContent=(tab.title||new URL(tab.url).hostname).slice(0,80)+' — '+new URL(tab.url).hostname;
    supplierTabSelect.append(option);
  }
  const prior=eligible.find(t=>String(t.id)===previous);
  const matching=eligible.find(t=>sourceDomain && new URL(t.url).hostname.replace(/^www\./,'')===sourceDomain);
  const chosen=prior||matching||eligible.filter(t=>t.active).sort((a,b)=>(b.lastAccessed||0)-(a.lastAccessed||0))[0]||eligible[0];
  if(chosen)supplierTabSelect.value=String(chosen.id);
  scanOpenButton.disabled=!eligible.length;
  return eligible;
}
document.getElementById('refresh-supplier-tabs').addEventListener('click',()=>{
  supplierTabs().catch(error=>{status.textContent='Could not list supplier tabs: '+error.message;});
});
scanOpenButton.addEventListener('click',async()=>{
  scanOpenButton.disabled=true;
  status.textContent='Scanning selected supplier tab…';
  try{
    const tabId=Number(supplierTabSelect.value);
    const tab=await chrome.tabs.get(tabId);
    if(!tab?.id||!/^https?:\/\//i.test(tab.url||''))throw new Error('Select an open supplier website.');
    const url=new URL(tab.url);
    if(/(^|\.)retail\.lightspeed\.app$/i.test(url.hostname))throw new Error('Choose a supplier page, not Lightspeed.');
    // This request must happen in this click handler for Chrome user-gesture authorization.
    const origin=url.origin+'/*';
    const hasAccess=await chrome.permissions.contains({origins:[origin]});
    if(!hasAccess){
      const granted=await chrome.permissions.request({origins:[origin]});
      if(!granted)throw new Error('Supplier website access was not granted.');
    }
    const [{result:draft}]=await chrome.scripting.executeScript({target:{tabId:tab.id},func:captureSupplierProductPage});
    if(!draft||!draft.product)throw new Error('No product information was returned.');
    draft.supplierDomain=url.hostname.toLowerCase().replace(/^www\./,'');
    await chrome.storage.local.set({scannerDraft:draft});
    loadScannerDraft(draft);
    if(!draft.requiresSelection)status.textContent='Captured '+(draft.product.name||'supplier product')+'. Review the fields; existing products are checked automatically.';
  }catch(error){status.textContent='Could not scan supplier page: '+error.message;}
  finally{scanOpenButton.disabled=false;}
});
supplierTabs().catch(error=>{status.textContent='Supplier tabs unavailable: '+error.message;});

installHobbyCornerNavigation(document.getElementById('hc-shared-navigation'),{current:'product-scanner'});
