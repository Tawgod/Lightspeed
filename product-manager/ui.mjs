import {previewChanges} from './validation.js';
const products=[
{id:'a',sku:'00012345',upc:'012345678905',name:'Example Model Kit',price:39.99,itemOnline:false,active:true,description:'Scale model kit'},
{id:'b',sku:'BHG-020',upc:'000012340005',name:'Example Card Sleeves',price:9.95,itemOnline:true,active:true,description:'Protective sleeves'},
{id:'c',sku:'RC-102',upc:'',name:'Example RC Accessory',price:18.50,itemOnline:false,active:false,description:''},
{id:'d',sku:'PZL-004',upc:'000000123401',name:'Example Puzzle',price:24.99,itemOnline:true,active:true,description:'1000-piece puzzle'}];
const $=id=>document.getElementById(id);let selected=products[0].id;
const drafts=new Map();let profile='Default';
const escapeHTML=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const effective=(p,f)=>drafts.has(p.id+'|'+f)?drafts.get(p.id+'|'+f).newValue:p[f];
const message=s=>$('feedback').textContent=s;
function renderRows(){const q=$('query').value.toLocaleLowerCase(),hide=$('hide-inactive').checked;
const rows=products.filter(p=>(!hide||p.active)&&[p.sku,p.upc,p.name].some(v=>String(v).toLowerCase().includes(q)));
$('rows').innerHTML=rows.map(p=>`<tr class="pm-row" tabindex="0" role="button" aria-label="Select ${escapeHTML(p.name)}" aria-selected="${p.id===selected}" data-id="${p.id}"><td class="pm-sku">${escapeHTML(p.sku)}</td><td>${escapeHTML(effective(p,'name'))}</td><td>$${Number(effective(p,'price')).toFixed(2)}</td><td>${effective(p,'itemOnline')?'Yes':'No'}</td><td>${p.active?'Active':'Inactive'}</td></tr>`).join('');
$('empty').hidden=rows.length!==0;
for(const el of $('rows').querySelectorAll('[data-id]')){const act=()=>{selected=el.dataset.id;$('view').value='summary';render()};el.onclick=act;el.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();act()}}}}
function stage(field,value,{deferRender=false}={}){const p=products.find(x=>x.id===selected),k=p.id+'|'+field;if(Object.is(p[field],value))drafts.delete(k);
else drafts.set(k,{productId:p.id,field,oldValue:p[field],newValue:value});
if(!deferRender){message('Draft staged locally. Review changes before any future approval.');render();}}
function renderDetails(){const p=products.find(x=>x.id===selected),mode=$('view').value,detail=$('detail');
if(mode==='images'){detail.innerHTML='<div class="pm-image">No sample image. X-Series images would appear here.</div><p class="hc-small hc-muted">Image positions and Google Drive matches remain disconnected.</p>';return}
if(mode==='summary'){detail.innerHTML=`<div class="pm-image" aria-label="No sample image">Picture preview</div><h3>${escapeHTML(effective(p,'name'))}</h3><p class="pm-sku">SKU: ${escapeHTML(p.sku)}</p><p>UPC: <span class="pm-sku">${escapeHTML(p.upc)}</span></p><p>Retail: $${Number(effective(p,'price')).toFixed(2)}</p><p>Online (X): ${effective(p,'itemOnline')?'Yes':'No'}</p><p class="hc-inset">${escapeHTML(p.description)||'No description'}</p>`;return}
detail.innerHTML=`<div class="pm-field"><label for="edit-name">Product name</label><input id="edit-name" class="hc-input" value="${escapeHTML(effective(p,'name'))}"></div>
<div class="pm-field"><label for="edit-price">Retail price ($)</label><input id="edit-price" type="text" inputmode="decimal" class="hc-input" value="${escapeHTML(effective(p,'price'))}"></div>
<div class="pm-field"><label for="edit-online">Item online (X)</label><select id="edit-online" class="hc-select"><option value="false">No</option><option value="true" ${effective(p,'itemOnline')?'selected':''}>Yes</option></select></div>
<p class="hc-small hc-muted">SKU: <span class="pm-sku">${escapeHTML(p.sku)}</span> (read-only sample)</p>
<div class="pm-action-row"><button type="button" id="stage-fields" class="hc-button">Stage edited fields</button></div>`;
$('stage-fields').onclick=()=>{const name=$('edit-name').value,price=$('edit-price').value;const n=Number(price);
if(!name.trim()||!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(price)||!Number.isFinite(n)){message('Validation failed. Name and a nonnegative price with at most two decimals are required. Nothing staged.');return}
const online=$('edit-online').value==='true';stage('name',name,{deferRender:true});stage('price',n,{deferRender:true});stage('itemOnline',online,{deferRender:true});message('Draft fields staged locally; no Lightspeed changes.');render()};}
function renderReview(){const updates=[...drafts.values()],result=previewChanges(products,updates);
$('change-count').textContent=String(updates.length);
$('review-list').innerHTML=updates.length?updates.map(u=>{const p=products.find(x=>x.id===u.productId);return `<div class="hc-inset pm-edited"><strong>${escapeHTML(p.sku)} · ${escapeHTML(u.field)}</strong><p class="hc-small">Before: ${escapeHTML(String(u.oldValue??''))}</p><p class="hc-small">Draft: ${escapeHTML(String(u.newValue??''))}</p><button type="button" class="hc-button hc-button--quiet" data-undo="${escapeHTML(p.id+'|'+u.field)}">Undo field</button></div>`}).join(''):'<div class="hc-empty">No pending changes.</div>';
for(const b of $('review-list').querySelectorAll('[data-undo]'))b.onclick=()=>{drafts.delete(b.dataset.undo);message('Single field draft discarded.');render()};
if(result.errors.length)message('Review validation detected '+result.errors.length+' issue(s). No changes applied.');}
function render(){renderRows();renderDetails();renderReview()}
$('query').addEventListener('input',renderRows);$('hide-inactive').onchange=renderRows;
$('view').onchange=renderDetails;
$('profile').onchange=e=>{profile=e.target.value;message(profile+' layout selected (demo; no saved server preferences).')};
$('reset').onclick=()=>{drafts.clear();message('All local draft edits discarded.');render()};
$('review-top').onclick=()=>{renderReview();$('changes').scrollIntoView({behavior:'smooth'})};
render();
/* Timeclock staff-auth integration: tokens are memory-only and never stored in
   localStorage. Profiles are keyed server-side exclusively by verified employee ID.
   No product data is transmitted to this profile endpoint. */
const authState={token:null,employee:null,expiresAt:0,profiles:{}};
const profileLayout=()=>({columns:['sku','name','price','itemOnline','active'],hidden:[],widths:{},detailsOrder:[]});
function clearEmployeeSession(note='Signed out. Your saved layouts remain on the server.'){
  authState.token=null;authState.employee=null;authState.expiresAt=0;authState.profiles={};
  $('pm-pin').value='';$('pm-pin').disabled=false;$('pm-login').hidden=false;
  $('pm-sign-out').hidden=true;$('pm-save-profile').disabled=true;
  $('pm-auth-state').textContent='Not signed in';$('pm-employee').textContent=note;
  $('profile').value='Default';profile='Default';drafts.clear();render();
}
async function profileRequest(path,options={}){
  if(!authState.token||Date.now()>=authState.expiresAt){clearEmployeeSession('Session expired. Sign in again.');throw Error('Employee session required.')}
  const response=await fetch('/api/product-manager'+path,{
    ...options,cache:'no-store',headers:{Authorization:'Bearer '+authState.token,...options.headers}
  });
  if(response.status===401||response.status===403){clearEmployeeSession('Employee access revoked or session expired.');throw Error('Employee access denied.')}
  if(!response.ok)throw Error(response.status===503?'Profile service unavailable. No changes saved.':'Profile request failed. No changes saved.');
  return response.json();
}
$('pm-sign-in').addEventListener('submit',async e=>{
  e.preventDefault();const pin=$('pm-pin').value;
  if(!/^\d{4}$/.test(pin)){$('pm-employee').textContent='Enter a four-digit Timeclock PIN.';return}
  $('pm-login').disabled=true;$('pm-employee').textContent='Verifying employee…';
  try{
    const response=await fetch('/api/staff-auth/session',{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin})});
    if(!response.ok)throw Error('Employee PIN not recognized or authentication unavailable.');
    const data=await response.json();
    if(!data.token||!Number.isSafeInteger(Number(data.employee?.id))||Number(data.expiresIn)<=0)throw Error('Invalid employee session.');
    authState.token=data.token;authState.employee={id:data.employee.id,name:data.employee.name};
    authState.expiresAt=Date.now()+Math.min(data.expiresIn,900)*1000;
    $('pm-auth-state').textContent='Signed in';$('pm-pin').disabled=true;$('pm-login').hidden=true;
    $('pm-sign-out').hidden=false;$('pm-save-profile').disabled=false;
    $('pm-employee').textContent='Signed in: '+(data.employee.name||'Employee')+'. Personal layouts enabled.';
    await loadEmployeeProfiles();
  }catch(err){if(!authState.employee)clearEmployeeSession(err.message);else $('pm-employee').textContent=err.message;}
  finally{$('pm-pin').value='';$('pm-login').disabled=false}
});
async function loadEmployeeProfiles(){
  try{const result=await profileRequest('/profiles');authState.profiles={};
    for(const p of result.profiles||[])authState.profiles[p.slot]=p.config;
    $('pm-employee').textContent='Signed in: '+(authState.employee?.name||'Employee')+'. Personal layouts loaded.';
  }catch(err){$('pm-employee').textContent=err.message}
}
$('pm-sign-out').onclick=()=>clearEmployeeSession();
$('pm-save-profile').onclick=async()=>{
  if(!authState.employee){$('pm-employee').textContent='Sign in before saving a layout.';return}
  const button=$('pm-save-profile');button.disabled=true;
  try{const saved=await profileRequest('/profiles/'+encodeURIComponent(profile),{
    method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({config:profileLayout()})
  });authState.profiles[profile]=saved.profile.config;
    $('pm-employee').textContent=profile+' saved for '+(authState.employee?.name||'employee')+'.';
  }catch(err){$('pm-employee').textContent=err.message}
  finally{button.disabled=!authState.employee}
};
