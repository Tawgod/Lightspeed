import { normalizeMatches, toSpecialOrderMatchRequest } from '/consignment-match-utils.js';

// This is deliberately a browser-local review beta. It never sends customer data
// or product writes to Lightspeed or to the Hobby Corner production database.
const KEY='hc-consignment-review-beta-v3';
const types=['Game','Puzzle','RC','Other'];
const statuses={PENDING_REVIEW:'Pending review',REJECTED:'Rejected',FOR_SALE:'For sale',SOLD_HOLD:'Sold · 3-day hold',CREDIT_DUE:'Credit due',CREDITED:'Credited',RETURNED_TO_SELLER:'Returned to seller'};
const sourceCatalog=[
{id:'new-game-1',name:'Ticket to Ride',sku:'DOW 7201',brand:'Days of Wonder',description:'Classic cross-country train route strategy game',type:'Game',historical:false},
{id:'new-game-2',name:'Catan',sku:'CN3071',brand:'Catan Studio',description:'Base game, 5th edition',type:'Game',historical:true},
{id:'new-puzzle-1',name:'Ravensburger World of Books 1000 Piece Puzzle',sku:'RAV 17301',brand:'Ravensburger',description:'1000 piece jigsaw puzzle',type:'Puzzle',historical:false},
{id:'new-puzzle-2',name:'White Mountain General Store 1000 Piece Puzzle',sku:'WM 1701',brand:'White Mountain',description:'1000 piece puzzle',type:'Puzzle',historical:true},
{id:'new-rc-1',name:'Traxxas Slash 2WD',sku:'TRA58034',brand:'Traxxas',description:'RC short course truck, 2WD',type:'RC',historical:true},
{id:'new-game-3',name:'Azul',sku:'PBG 40020',brand:'Next Move Games',description:'Tile drafting family game',type:'Game',historical:false}
];
const $=id=>document.getElementById(id);
const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=v=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(Number(v)||0);
const daysAgo=d=>new Date(Date.now()-d*86400000).toISOString();
function seed(){
  return {nextSeq:1300,settings:{maxItems:5,agingDays:45},submissions:[
    {id:'SUB-00081',customer:'Sample Customer A',source:'online',submittedAt:daysAgo(4)},
    {id:'SUB-00082',customer:'Sample Customer B',source:'staff',submittedAt:daysAgo(27)},
    {id:'SUB-00083',customer:'Sample Customer C',source:'online',submittedAt:daysAgo(83)}
  ],items:[
    {id:'UG-001284',submissionId:'SUB-00081',customer:'Sample Customer A',type:'Game',name:'Ticket to Ride',price:25,condition:'Good',status:'PENDING_REVIEW',createdAt:daysAgo(4),source:'online',notes:'Complete and clean',templateId:null},
    {id:'PZ-001285',submissionId:'SUB-00081',customer:'Sample Customer A',type:'Puzzle',name:'Ravensburger World of Books 1000 Piece Puzzle',price:14,condition:'Very Good',status:'PENDING_REVIEW',createdAt:daysAgo(4),source:'online',notes:'All pieces counted',templateId:null},
    {id:'RC-001286',submissionId:'SUB-00082',customer:'Sample Customer B',type:'RC',name:'Traxxas Slash 2WD',price:95,condition:'Good',status:'FOR_SALE',createdAt:daysAgo(27),source:'staff',notes:'Tested working; no battery',templateId:'new-rc-1'},
    {id:'UG-001287',submissionId:'SUB-00082',customer:'Sample Customer B',type:'Game',name:'Azul',price:22,condition:'Like New',status:'FOR_SALE',createdAt:daysAgo(52),source:'staff',notes:'',templateId:'new-game-3'},
    {id:'PZ-001288',submissionId:'SUB-00083',customer:'Sample Customer C',type:'Puzzle',name:'White Mountain General Store 1000 Piece Puzzle',price:9,condition:'Good',status:'FOR_SALE',createdAt:daysAgo(83),source:'online',notes:'',templateId:'new-puzzle-2'},
    {id:'UG-001289',submissionId:'SUB-00083',customer:'Sample Customer C',type:'Game',name:'Catan',price:19,condition:'Very Good',status:'SOLD_HOLD',createdAt:daysAgo(12),soldAt:daysAgo(1),source:'online',notes:'',templateId:'new-game-2'},
    {id:'UG-001290',submissionId:'SUB-00082',customer:'Sample Customer B',type:'Game',name:'Catan',price:18,condition:'Good',status:'CREDIT_DUE',createdAt:daysAgo(22),soldAt:daysAgo(5),source:'staff',notes:'',templateId:'new-game-2'},
    {id:'UG-001291',submissionId:'SUB-00082',customer:'Sample Customer B',type:'Game',name:'Ticket to Ride',price:24,condition:'Good',status:'CREDITED',creditedAt:daysAgo(12),creditAmount:19.2,createdAt:daysAgo(39),soldAt:daysAgo(16),source:'staff',notes:'',templateId:'new-game-1'}
  ]};
}
function load(){try{const s=JSON.parse(localStorage.getItem(KEY)||'null');if(s&&Array.isArray(s.items)&&Array.isArray(s.submissions)&&s.settings)return s;}catch{}return seed();}
let db=load(),selected='UG-001284',currentTab='ALL',currentView='inventory',search='';
function save(){localStorage.setItem(KEY,JSON.stringify(db));}
function age(item){return Math.max(0,Math.floor((Date.now()-new Date(item.createdAt).getTime())/86400000));}
function notify(msg){const el=$('toast');el.textContent=msg;el.classList.remove('hide');clearTimeout(notify.timer);notify.timer=setTimeout(()=>el.classList.add('hide'),3500);}
function itemActive(item){return ['PENDING_REVIEW','FOR_SALE','SOLD_HOLD','CREDIT_DUE'].includes(item.status);}
function setView(view){
 currentView=view;
 for(const el of document.querySelectorAll('[data-view]')){el.classList.toggle('active',el.dataset.view===view);}
 for(const name of ['inventory','detail','submission','portal','settings']){$(name+'-panel').classList.toggle('hide',name!==view&&(view!=='inventory'||name!=='detail'));}
 if(view==='inventory')$('detail-panel').classList.remove('hide');
 for(const name of ['submission','portal','settings'])$(name+'-panel').style.gridColumn='1 / -1';
 if(view==='portal')renderPortal();
 if(view==='settings')renderSettings();
}
function metrics(){
 const count=status=>db.items.filter(i=>i.status===status).length;
 const aging=db.items.filter(i=>i.status==='FOR_SALE'&&age(i)>=db.settings.agingDays).length;
 const values=[
 ['Pending approval',count('PENDING_REVIEW'),'Waiting for inspection'],
 ['Available for sale',count('FOR_SALE'),'Active used items'],
 ['Sold / credit hold',count('SOLD_HOLD')+count('CREDIT_DUE'),'No automatic credits in beta'],
 ['Aging products',aging,'Over '+db.settings.agingDays+' days']];
 $('metrics').innerHTML=values.map(x=>'<div class="metric"><div class="label">'+escapeHtml(x[0])+'</div><div class="number">'+x[1]+'</div><div class="tiny muted">'+escapeHtml(x[2])+'</div></div>').join('');
}
function itemsList(){
 let rows=db.items.filter(i=>(currentTab==='ALL'||(currentTab==='AGING'?i.status==='FOR_SALE'&&age(i)>=db.settings.agingDays:i.status===currentTab))&&(!search||[i.id,i.name,i.customer].some(v=>v.toLowerCase().includes(search)))&&(!$('type-filter').value||i.type===$('type-filter').value));
 rows.sort((a,b)=>{const rank={PENDING_REVIEW:0,CREDIT_DUE:1,SOLD_HOLD:2,FOR_SALE:3,CREDITED:4,RETURNED_TO_SELLER:5,REJECTED:6};return (rank[a.status]??10)-(rank[b.status]??10)||new Date(a.createdAt)-new Date(b.createdAt)});
 $('item-count').textContent=rows.length+' of '+db.items.length+' items';
 $('items-body').innerHTML=rows.length?rows.map(i=>'<tr class="itemrow '+(i.id===selected?'selected':'')+'" data-id="'+escapeHtml(i.id)+'"><td><strong>'+escapeHtml(i.name)+'</strong><br><span class="muted">'+escapeHtml(i.id)+'</span></td><td>'+escapeHtml(i.customer)+'</td><td>'+money(i.price)+'</td><td>'+age(i)+'</td><td><span class="pill '+escapeHtml(i.status)+'">'+escapeHtml(statuses[i.status]||i.status)+'</span></td></tr>').join(''):'<tr><td colspan="5" class="empty">No items match these filters.</td></tr>';
}
function norm(s){return String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();}
function candidates(item){
 const request=toSpecialOrderMatchRequest({name:item.name,sku:item.originalSku||'',description:item.notes||''});
 const q=norm(request.name);const qt=q.split(' ').filter(t=>t.length>1&&t!=='the'&&t!=='and'&&t!=='used');
 let all=sourceCatalog.filter(p=>p.type===item.type).map(p=>{
 const n=norm(p.name), nt=n.split(' ');
 let score=0,reasons=[];
 if(n===q){score+=86;reasons.push('Exact title');}
 if(request.sku&&norm(request.sku)===norm(p.sku)){score=100;reasons.push('Exact SKU');}
 const overlap=qt.filter(t=>nt.includes(t)).length;
 if(qt.length&&overlap){score+=Math.round(46*overlap/qt.length);reasons.push('Title tokens '+overlap+'/'+qt.length);}
 if(n.includes(q)&&q.length>3){score+=14;reasons.push('Contained title');}
 if(p.historical)reasons.push('Historical / inactive new-product template');
 return {...p,lightspeed_product_id:p.id,score:Math.min(score,100),reasons,source:'demo'};
 }).filter(p=>p.score>=20).sort((a,b)=>b.score-a.score).slice(0,4);
 // Reuse scanner match normalization; live implementation will use the same
 // Special Orders local and Lightspeed remote lookup contracts.
 return normalizeMatches(all,[]).map(x=>({...x,template:sourceCatalog.find(p=>p.id===x.lightspeedId)}));
}
function selectedItem(){return db.items.find(i=>i.id===selected);}
function matchMarkup(item){
 const matches=candidates(item);
 if(!matches.length)return '<div class="note">No similar items in the sample catalog. You can still approve this item without copying a product. The real matching gateway is not connected yet.</div>';
 return matches.map((m,n)=>{
 const template=m.template; const chosen=item.templateId===template.id;
 return '<div class="match '+(n===0?'best':'')+'"><div class="section-head"><span class="title">'+escapeHtml(template.name)+'</span><span class="pill">'+(chosen?'Selected':'Score '+m.score)+'</span></div><p class="muted tiny">'+escapeHtml(template.brand)+' · '+escapeHtml(template.sku)+(template.historical?' · Historical item':' · Current item')+'</p><p class="small">'+escapeHtml(template.description)+'</p><p class="muted tiny">'+escapeHtml(m.reasons.join(' · '))+'</p><button class="btn small '+(chosen?'secondary':'')+'" data-action="match" data-template="'+escapeHtml(template.id)+'" '+(chosen?'disabled':'')+'>'+(chosen?'Selected template':'Use description as template')+'</button></div>';
 }).join('');
}
function renderDetails(){
 const i=selectedItem();if(!i){$('detail-title').textContent='Item details';$('details').innerHTML='<div class="empty">Select a consignment item.</div>';return;}
 $('detail-title').textContent=i.id+' · '+statuses[i.status];
 const match=sourceCatalog.find(p=>p.id===i.templateId);
 const sold=i.soldAt?'Sale recorded (demo): '+new Date(i.soldAt).toLocaleDateString()+' · Credit eligible after '+new Date(new Date(i.soldAt).getTime()+72*3600000).toLocaleString():'';
 const warning=db.items.filter(x=>x.customer===i.customer&&itemActive(x)).length>db.settings.maxItems;
 const btns=[];
 if(i.status==='PENDING_REVIEW'){btns.push(['approve','Approve for sale']);btns.push(['reject','Reject item']);}
 if(i.status==='FOR_SALE'){btns.push(['sell','Simulate sale']);btns.push(['return','Return to consignor']);}
 if(i.status==='SOLD_HOLD'){btns.push(['eligible','Preview credit eligibility']);}
 if(i.status==='CREDIT_DUE'){btns.push(['credit','Simulate credit']);}
 let buttons=btns.map(b=>'<button class="btn small '+(['reject','return'].includes(b[0])?'secondary':'')+'" data-action="'+b[0]+'">'+b[1]+'</button>').join('');
 $('details').innerHTML=
 '<div class="section-head"><strong>'+escapeHtml(i.name)+'</strong><span class="pill '+escapeHtml(i.status)+'">'+escapeHtml(statuses[i.status])+'</span></div>'+
 '<dl class="kv"><dt>Consignor</dt><dd>'+escapeHtml(i.customer)+'</dd><dt>Submission</dt><dd>'+escapeHtml(i.submissionId)+' · '+escapeHtml(i.source)+'</dd><dt>Product type</dt><dd>'+escapeHtml(i.type)+'</dd><dt>Days in store</dt><dd>'+age(i)+'</dd><dt>Condition</dt><dd>'+escapeHtml(i.condition)+'</dd><dt>Category</dt><dd>General › Consignment</dd><dt>Used SKU</dt><dd>'+escapeHtml(i.id)+'</dd><dt>POS sync</dt><dd>Not connected</dd></dl>'+
 (warning?'<p class="warnings">Consignor exceeds the normal '+db.settings.maxItems+' active-item limit. Staff override is allowed.</p>':'')+
 (i.status==='FOR_SALE'&&age(i)>=db.settings.agingDays?'<div class="warnings">Aging warning: request a price review or arrange customer pickup if appropriate.</div>':'')+
 (sold?'<p class="note">'+escapeHtml(sold)+'</p>':'')+
 (i.creditedAt?'<div class="banner">Sample store credit recorded: '+money(i.creditAmount)+' · No actual Lightspeed credit posted.</div>':'')+
 '<div class="line"></div><h3>Price and condition</h3>'+
 '<div class="two"><div class="field"><label for="edit-price">Customer asking price</label><input id="edit-price" type="number" min="0" step=".01" value="'+escapeHtml(i.price)+'"></div><div class="field"><label for="edit-condition">Condition</label><select id="edit-condition">'+['New in Shrink','Like New','Very Good','Good','Fair','Poor','Scrap / Parts'].map(c=>'<option '+(i.condition===c?'selected':'')+'>'+c+'</option>').join('')+'</select></div></div>'+
 '<div class="actions"><button class="btn secondary small" data-action="update" '+(['CREDITED','RETURNED_TO_SELLER','REJECTED'].includes(i.status)?'disabled':'')+'>Save item edits</button></div>'+
 '<div class="line"></div><h3>Existing-product suggestions</h3><p class="muted tiny">Suggestions are computed when staff open customer online submissions, too. Matching list uses synthetic catalog data and the shared scanner normalization module.</p>'+matchMarkup(i)+
 '<div class="note">'+(match?'Selected product template: '+escapeHtml(match.name)+' ('+escapeHtml(match.sku)+'). ': 'No product template selected. ')+
 'POS product preview: <strong>USED — '+escapeHtml(i.name)+'</strong>; new unique SKU <strong>'+escapeHtml(i.id)+'</strong>. Only approved descriptive fields are copied. Original image, barcode, inventory, cost, and supplier configuration are excluded.</div>'+
 '<div class="line"></div><div class="actions">'+buttons+'</div>';
}
function renderPortal(){
 const customers=[...new Set(db.items.map(i=>i.customer))].sort();
 const chosen=$('portal-customer').value;
 $('portal-customer').innerHTML=customers.map(c=>'<option '+(chosen===c?'selected':'')+' value="'+escapeHtml(c)+'">'+escapeHtml(c)+'</option>').join('');
 const customer=$('portal-customer').value;
 const items=db.items.filter(i=>i.customer===customer);
 const credited=items.filter(i=>i.status==='CREDITED').reduce((sum,i)=>sum+Number(i.creditAmount||0),0);
 const upcoming=items.filter(i=>['SOLD_HOLD','CREDIT_DUE'].includes(i.status)).reduce((sum,i)=>sum+Number(i.price)*.8,0);
 $('portal-body').innerHTML='<div class="banner" style="margin:14px 0">Customer view for <strong>'+escapeHtml(customer||'')+'</strong><br><strong>'+money(credited)+'</strong> issued credit in this demo · '+money(upcoming)+' pending credit. This is a historical credit preview, <strong>not</strong> the actual available Lightspeed account balance.</div>'+
 items.map(i=>'<div class="details" style="border-top:1px solid #edf0f2;padding:12px 0"><strong>'+escapeHtml(i.name)+'</strong> <span class="pill '+escapeHtml(i.status)+'">'+escapeHtml(statuses[i.status])+'</span><div class="tiny muted">'+escapeHtml(i.id)+' · '+money(i.price)+' · '+escapeHtml(i.condition)+'</div></div>').join('');
}
function renderSettings(){$('max-items').value=db.settings.maxItems;$('age-days').value=db.settings.agingDays;}
function refresh(){metrics();itemsList();renderDetails();if(currentView==='portal')renderPortal();}
function setStatus(next){
 const i=selectedItem();if(!i)return;
 i.status=next;
 if(next==='SOLD_HOLD'){i.soldAt=new Date().toISOString();}
 if(next==='CREDITED'){i.creditedAt=new Date().toISOString();i.creditAmount=Math.round(i.price*80)/100;i.posActive=false;}
 i.updatedAt=new Date().toISOString();
 save();refresh();notify(i.id+' → '+statuses[next]+' (sample only)');
}
function addFormItem(){
 const div=document.createElement('div');div.className='item-box';
 div.innerHTML='<button type="button" class="btn ghost small remove" data-remove>Remove</button>'+
 '<div class="itemgrid"><div class="field"><label>Item name</label><input name="itemName" maxlength="160" required placeholder="Game, puzzle, RC item"></div>'+
 '<div class="field"><label>Type</label><select name="itemType"><option>Game</option><option>Puzzle</option><option>RC</option><option>Other</option></select></div>'+
 '<div class="field"><label>Asking price</label><input name="itemPrice" type="number" min="0" step=".01" required placeholder="0.00"></div></div>'+
 '<div class="two" style="margin-top:10px"><div class="field"><label>Condition</label><select name="itemCondition"><option>Like New</option><option>Very Good</option><option>Good</option><option>Fair</option><option>Poor</option><option>New in Shrink</option><option>Scrap / Parts</option></select></div><div class="field"><label>Other details</label><input name="itemNotes" maxlength="400" placeholder="Missing components, tested, smoke / pet conditions"></div></div>';
 $('submission-items').appendChild(div);
}
function createSubmission(ev){
 ev.preventDefault();
 const seller=$('seller').value.trim();if(!seller)return notify('Consignor name is required.');
 const boxes=[...$('submission-items').querySelectorAll('.item-box')];
 if(!boxes.length)return notify('Add at least one item.');
 const created=boxes.map(box=>{
 const field=name=>box.querySelector('[name="'+name+'"]').value.trim();
 const name=field('itemName'),price=Number(field('itemPrice'));
 if(!name||!Number.isFinite(price)||price<0)throw new Error('Check every item title and price.');
 return {name,price,type:field('itemType'),condition:field('itemCondition'),notes:field('itemNotes')};
 });
 const num=db.nextSeq++;
 const submissionId='SUB-'+String(num).padStart(5,'0');
 db.submissions.push({id:submissionId,customer:seller,source:$('channel').value,notes:$('notes').value.trim(),submittedAt:new Date().toISOString()});
 const newItems=created.map(product=>{
 const seq=db.nextSeq++;const id={Game:'UG',Puzzle:'PZ',RC:'RC',Other:'US'}[product.type]+'-'+String(seq).padStart(6,'0');
 return {id,submissionId,customer:seller,source:$('channel').value,status:'PENDING_REVIEW',createdAt:new Date().toISOString(),templateId:null,...product};
 });
 db.items.unshift(...newItems);save();selected=newItems[0].id;currentTab='PENDING_REVIEW';
 document.querySelectorAll('[data-status]').forEach(el=>el.classList.toggle('active',el.dataset.status===currentTab));
 $('submission-form').reset();$('submission-items').innerHTML='';addFormItem();setView('inventory');refresh();notify(created.length+' item(s) submitted for staff approval — sample only');
}
$('items-body').addEventListener('click',ev=>{const tr=ev.target.closest('[data-id]');if(tr){selected=tr.dataset.id;refresh();}});
$('status-tabs').addEventListener('click',ev=>{const tab=ev.target.closest('[data-status]');if(!tab)return;currentTab=tab.dataset.status;document.querySelectorAll('[data-status]').forEach(t=>t.classList.toggle('active',t===tab));itemsList();});
$('search').addEventListener('input',ev=>{search=ev.target.value.toLowerCase().trim();itemsList();});
$('type-filter').addEventListener('change',itemsList);
$('detail-panel').addEventListener('click',ev=>{
 const el=ev.target.closest('[data-action]');if(!el)return;
 const action=el.dataset.action,i=selectedItem();if(!i)return;
 if(action==='match'){const template=sourceCatalog.find(p=>p.id===el.dataset.template);if(!template)return;i.templateId=template.id;i.brand=template.brand;i.description=template.description;save();refresh();notify('Template selected. Original photo is excluded.');}
 if(action==='update'){const p=Number($('edit-price').value);if(!Number.isFinite(p)||p<0)return notify('Please enter a valid price.');i.price=p;i.condition=$('edit-condition').value;save();refresh();notify('Item changes saved in the demo.');}
 if(action==='approve')setStatus('FOR_SALE');
 if(action==='reject'&&confirm('Reject this sample item?'))setStatus('REJECTED');
 if(action==='return'&&confirm('Mark this sample item returned to consignor?'))setStatus('RETURNED_TO_SELLER');
 if(action==='sell')setStatus('SOLD_HOLD');
 if(action==='eligible'){if(Date.now()-new Date(i.soldAt).getTime()<72*3600000){return notify('Three full days have not elapsed. Credit must remain on hold.');}setStatus('CREDIT_DUE');}
 if(action==='credit'){if(Date.now()-new Date(i.soldAt).getTime()<72*3600000)return notify('Credit is not eligible until three full days after sale.');setStatus('CREDITED');}
});
document.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>setView(b.dataset.view)));
$('new-submission').addEventListener('click',()=>setView('submission'));
$('add-item').addEventListener('click',addFormItem);
$('submission-items').addEventListener('click',ev=>{if(ev.target.closest('[data-remove]')){ev.target.closest('.item-box').remove();}});
$('submission-form').addEventListener('submit',ev=>{try{createSubmission(ev);}catch(err){notify(err.message)}});
$('cancel-submission').addEventListener('click',()=>setView('inventory'));
$('portal-customer').addEventListener('change',renderPortal);
$('save-settings').addEventListener('click',()=>{
 const max=Number($('max-items').value),age=Number($('age-days').value);
 if(!Number.isInteger(max)||max<1||max>200||!Number.isInteger(age)||age<1||age>365)return notify('Use valid limit (1–200) and aging days (1–365).');
 db.settings={maxItems:max,agingDays:age};save();refresh();notify('Beta settings saved in this browser.');
});
$('reset').addEventListener('click',()=>{if(confirm('Replace sample changes with the original beta example records?')){db=seed();selected=db.items[0].id;save();refresh();notify('Sample data reset.');}});
addFormItem();renderSettings();setView('inventory');refresh();
