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
function stage(field,value){const p=products.find(x=>x.id===selected),k=p.id+'|'+field;if(Object.is(p[field],value))drafts.delete(k);
else drafts.set(k,{productId:p.id,field,oldValue:p[field],newValue:value});
message('Draft staged locally. Review changes before any future approval.');render();}
function renderDetails(){const p=products.find(x=>x.id===selected),mode=$('view').value,detail=$('detail');
if(mode==='images'){detail.innerHTML='<div class="pm-image">No sample image. X-Series images would appear here.</div><p class="hc-small hc-muted">Image positions and Google Drive matches remain disconnected.</p>';return}
if(mode==='summary'){detail.innerHTML=`<div class="pm-image" aria-label="No sample image">Picture preview</div><h3>${escapeHTML(effective(p,'name'))}</h3><p class="pm-sku">SKU: ${escapeHTML(p.sku)}</p><p>UPC: <span class="pm-sku">${escapeHTML(p.upc)}</span></p><p>Retail: $${Number(effective(p,'price')).toFixed(2)}</p><p>Online (X): ${effective(p,'itemOnline')?'Yes':'No'}</p><p class="hc-inset">${escapeHTML(p.description)||'No description'}</p>`;return}
detail.innerHTML=`<div class="pm-field"><label for="edit-name">Product name</label><input id="edit-name" class="hc-input" value="${escapeHTML(effective(p,'name'))}"></div>
<div class="pm-field"><label for="edit-price">Retail price ($)</label><input id="edit-price" type="text" inputmode="decimal" class="hc-input" value="${escapeHTML(effective(p,'price'))}"></div>
<div class="pm-field"><label for="edit-online">Item online (X)</label><select id="edit-online" class="hc-select"><option value="false">No</option><option value="true" ${effective(p,'itemOnline')?'selected':''}>Yes</option></select></div>
<p class="hc-small hc-muted">SKU: <span class="pm-sku">${escapeHTML(p.sku)}</span> (read-only sample)</p>
<div class="pm-action-row"><button type="button" id="stage-fields" class="hc-button">Stage edited fields</button></div>`;
$('stage-fields').onclick=()=>{const name=$('edit-name').value,price=$('edit-price').value;const n=Number(price);
if(!name.trim()||!/^(?:0|[1-9]\\d*)(?:\\.\\d{1,2})?$/.test(price)||!Number.isFinite(n)){message('Validation failed. Name and a nonnegative price with at most two decimals are required. Nothing staged.');return}
stage('name',name);stage('price',n);stage('itemOnline',$('edit-online').value==='true')};}
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