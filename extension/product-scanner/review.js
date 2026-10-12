import {checkProductMatches,toSpecialOrderMatchRequest} from './special-orders-adapter.js';


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

function clearScannerSession(){
  scannerSession=null;
  pinField.value='';
  signOutButton.hidden=true;
  signInForm.hidden=false;
  signInButton.disabled=false;
  signInButton.hidden=false;
  pinField.disabled=false;
  checkButton.disabled=true;
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
    scannerSession={token:data.token,expiresAt:Date.now()+data.expiresIn*1000};
    pinField.disabled=true;
    signInButton.hidden=true;
    signOutButton.hidden=false;
    employeeStatus.textContent='Signed in as '+(data.employee.name||'employee')+'. Read-only product lookup enabled.';
    checkButton.disabled=!draftAvailable;
  }catch(error){
    scannerSession=null;
    employeeStatus.textContent=error.message;
  }finally{
    pinField.value='';
    signInButton.disabled=false;
  }
});

const keys=['name','sku','upc','manufacturerPartNumber','brand','imageUrl','advertisedPrice','currency'];
const labels={name:'Product name',sku:'SKU',upc:'UPC / GTIN',manufacturerPartNumber:'Manufacturer part number',brand:'Brand',imageUrl:'Image URL',advertisedPrice:'Supplier advertised price (reference only)',currency:'Currency'};
const status=document.getElementById('status');
const matchStatus=document.getElementById('match-status');
const matchesElement=document.getElementById('matches');
const checkButton=document.getElementById('check-matches');

function currentProduct(){
  const product=Object.fromEntries(keys.map(k=>[k,document.getElementById('field-'+k).value.trim()]));
  product.description=document.getElementById('description').value.trim();
  return product;
}
function showMatches(matches){
  matchesElement.replaceChildren();
  if(!matches.length){matchesElement.textContent='No matches returned by both services. This is not approval to create a product.';return;}
  for(const match of matches){
    const box=document.createElement('div');box.className='card';
    const title=document.createElement('strong');title.textContent=match.name||'(Unnamed product)';
    const detail=document.createElement('p');
    detail.textContent=['SKU: '+(match.sku||'—'),'UPC: '+(match.upc||'—'),'Lightspeed ID: '+(match.lightspeedId||'not linked'),'Sources: '+match.sources.join(', ')].join(' | ');
    box.append(title,detail);
    if(match.lightspeedId){
      const select=document.createElement('button');select.type='button';select.textContent='Compare this product';
      select.addEventListener('click',()=>{
        document.getElementById('existing').value=match.lightspeedId;
        const diffs=['name','sku','upc','brand','description'].filter(k=>String(match[k]||'').trim()!==String(currentProduct()[k]||'').trim());
        matchStatus.textContent='Selected '+match.name+'. Fields to review: '+(diffs.join(', ')||'none')+'. No changes have been made.';
      });
      box.append(select);
    }
    matchesElement.append(box);
  }
}

chrome.storage.local.get('scannerDraft',({scannerDraft:d})=>{
  if(!d){status.textContent='No product has been captured. Use Scan Current Page in the extension.';checkButton.disabled=true;return;}
  status.textContent=d.requiresSelection?'Multiple products detected — automatic selection is disabled. Verify manually.':'Review extracted information; no changes have been sent to Lightspeed.';
  draftAvailable=true;
  const p=d.product||{};
  if(/^https?:\/\//.test(d.sourceUrl||'')){document.getElementById('source').href=d.sourceUrl;}
  document.getElementById('source').textContent=d.sourceUrl||'Unknown source';
  document.getElementById('original').textContent=JSON.stringify({capturedAt:d.capturedAt,candidates:d.candidates,product:p},null,2);
  const fields=document.getElementById('fields');
  for(const k of keys){const label=document.createElement('label');label.textContent=labels[k];const input=document.createElement('input');input.id='field-'+k;input.value=p[k]??'';label.append(input);fields.append(label);}
  document.getElementById('description').value=p.description||'';
  const missing=['name','sku','upc'].filter(k=>!p[k]);
  document.getElementById('warnings').textContent=missing.length?'Check missing fields: '+missing.join(', '):'';
});
document.getElementById('copy').addEventListener('click',async()=>{
  try{await navigator.clipboard.writeText(JSON.stringify(currentProduct(),null,2));status.textContent='Proposed data copied. No Lightspeed changes made.';}
  catch(e){status.textContent='Clipboard failed: '+e.message;}
});

checkButton.addEventListener('click',async()=>{
  checkButton.disabled=true;matchStatus.textContent='Checking…';matchesElement.replaceChildren();
  try{
    if(!scannerSession || scannerSession.expiresAt<=Date.now()) {
      clearScannerSession();
      throw new Error('Your scanner session has expired. Please sign in again.');
    }
    // Both existing Special Orders searches are executed behind one authenticated
    // server endpoint. The browser never receives the Special Orders admin key.
    const body=toSpecialOrderMatchRequest(currentProduct());
    const response=await fetch(SCANNER_API+'/matches',{
      method:'POST',cache:'no-store',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+scannerSession.token},
      body:JSON.stringify(body)
    });
    if(!response.ok) {
      if(response.status===401||response.status===403)clearScannerSession();
      throw new Error(response.status===404||response.status===503
        ? 'Secure scanner service is not available yet.'
        : 'Product verification failed ('+response.status+').');
    }
    const data=await response.json();
    if(data?.verified!==true || !Array.isArray(data.local?.matches) || !Array.isArray(data.remote?.matches)){
      throw new Error('Scanner service did not verify both matching sources.');
    }
    const lookup=async kind=>kind==='local'?data.local:data.remote;
    const result=await checkProductMatches(currentProduct(),lookup);
    if(!result.verified)throw new Error('Incomplete verification');
    showMatches(result.matches);
    matchStatus.textContent='Both matching services returned successfully. Review matches before taking action.';
  }catch(e){matchStatus.textContent='Not verified: '+e.message;}
  finally{checkButton.disabled=false;}
});
