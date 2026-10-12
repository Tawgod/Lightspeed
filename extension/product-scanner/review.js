import {checkProductMatches} from './special-orders-adapter.js';

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
    // The privileged gateway is not deployed. Never call admin-key-protected
    // Special Orders endpoints from an extension or store a secret in Chrome.
    // This fails closed until a restricted, employee-authenticated gateway exists.
    const lookup=async()=>{throw new Error('Secure Railway scanner gateway has not been deployed. Duplicate checking is unavailable.');};
    const result=await checkProductMatches(currentProduct(),lookup);
    if(!result.verified)throw new Error('Incomplete verification');
    showMatches(result.matches);
    matchStatus.textContent='Both matching services returned successfully. Review matches before taking action.';
  }catch(e){matchStatus.textContent='Not verified: '+e.message;}
  finally{checkButton.disabled=false;}
});
