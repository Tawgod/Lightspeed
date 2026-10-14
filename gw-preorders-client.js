const api='/api/special-orders';
let noticeTimer=null,lastPreviewCampaignId=null,lastPreview=null;

function showNotice(text,ms=0){const e=document.getElementById('notice');if(noticeTimer)clearTimeout(noticeTimer);e.textContent=text;e.style.display='block';if(ms)noticeTimer=setTimeout(()=>{e.style.display='none'},ms)}
function accessKey(){return sessionStorage.getItem('hcSpecialOrdersKey')||''}
function setAuthState(ok,msg=''){document.getElementById('authStatus').textContent=ok?'Unlocked':'Locked';document.querySelectorAll('button:not(#unlockButton), input:not(#accessKey), select').forEach(e=>e.disabled=!ok);document.getElementById('gwPublishButton').disabled=true;if(msg)showNotice(msg)}
async function getJson(url,opts={}){const headers={...(opts.headers||{}),'x-hobby-corner-key':accessKey()};const r=await fetch(url,{...opts,headers,cache:'no-store'});let d={};try{d=await r.json()}catch{}if(r.status===401){sessionStorage.removeItem('hcSpecialOrdersKey');setAuthState(false,'Access key required.');throw new Error('Access key missing or incorrect.')}if(!r.ok){const e=new Error(d.error||r.statusText);e.details=d;e.status=r.status;throw e}return d}
async function saveKey(){const v=document.getElementById('accessKey').value.trim();if(!v)return;sessionStorage.setItem('hcSpecialOrdersKey',v);try{await getJson(api+'/auth-check');setAuthState(true);await loadGwCampaigns();showNotice('GW Preorders ready.',1200)}catch(e){sessionStorage.removeItem('hcSpecialOrdersKey');setAuthState(false,e.message)}}

function chicagoLocal(iso){if(!iso)return'';const d=new Date(iso);const p=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(d);const g=t=>p.find(x=>x.type===t)?.value||'';return g('year')+'-'+g('month')+'-'+g('day')+'T'+g('hour')+':'+g('minute')}
function setTiming(c){if(c.gw_supplier_deadline_at)document.getElementById('gwSupplierDeadline').value=chicagoLocal(c.gw_supplier_deadline_at);if(c.order_due_at){document.getElementById('gwCustomerCutoff').value=chicagoLocal(c.order_due_at);document.getElementById('gwOrderDue').value=chicagoLocal(c.order_due_at)}if(c.gw_auto_submit_at)document.getElementById('gwAutoSubmitAt').value=chicagoLocal(c.gw_auto_submit_at);if([10,15,20,30,60].includes(Number(c.auto_submit_minutes_before)))document.getElementById('gwSubmitLeadMinutes').value=String(c.auto_submit_minutes_before)}

async function loadGwCampaigns(){const s=document.getElementById('gwCampaignSelect'),cur=s.value;const rows=await getJson(api+'/preorders/campaigns?type=GW_WEEKLY');s.innerHTML='<option value="">Select GW campaign…</option>';for(const c of rows){const o=document.createElement('option');o.value=c.id;o.textContent=(c.name||'GW campaign')+' — '+(c.external_submission_status||'NOT_SUBMITTED');s.appendChild(o)}if(cur&&[...s.options].some(o=>o.value===cur))s.value=cur}

function money(v){return v==null||v===''?'':Number(v).toFixed(2)}
async function patchItem(id,patch){const d=await getJson(api+'/preorders/gw/products/'+id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({...patch,gw_reviewed_by:'gw-web'})});lastPreview=null;lastPreviewCampaignId=null;document.getElementById('gwPublishButton').disabled=true;return d}

function renderCleanup(products){
 const box=document.getElementById('gwCleanupItems');box.replaceChildren();
 if(!products.length){box.textContent='No scraped items were saved for this campaign.';return}
 const table=document.createElement('table'),h=document.createElement('tr');
 for(const x of ['Item Description','Short Code','MSRP','Cost','Post Y/N']){const th=document.createElement('th');th.textContent=x;h.appendChild(th)}table.appendChild(h);
 for(const p of products){
   const tr=document.createElement('tr');
   const nameTd=document.createElement('td'),name=document.createElement('input');name.value=p.gw_case_pack_size>1?(p.gw_single_item_name||p.item_description):p.item_description;name.style.minWidth='260px';
   if(p.gw_case_pack_size>1){const note=document.createElement('div');note.className='form-note';note.textContent='Pack x'+p.gw_case_pack_size+' · suggested single from '+(p.gw_source_item_description||p.item_description);nameTd.append(name,note);name.addEventListener('change',()=>patchItem(p.id,{gw_single_item_name:name.value}))}else{nameTd.appendChild(name);name.addEventListener('change',()=>patchItem(p.id,{item_description:name.value}))}
   const codeTd=document.createElement('td'),code=document.createElement('input');code.value=p.sku||'';code.style.width='110px';code.addEventListener('change',()=>patchItem(p.id,{sku:code.value}));codeTd.appendChild(code);
   const msrpTd=document.createElement('td'),msrp=document.createElement('input');msrp.type='number';msrp.step='0.01';msrp.min='0';msrp.style.width='90px';msrp.value=money(p.gw_case_pack_size>1?p.gw_single_msrp:p.msrp);msrp.addEventListener('change',()=>patchItem(p.id,p.gw_case_pack_size>1?{gw_single_msrp:Number(msrp.value)}:{msrp:Number(msrp.value)}));msrpTd.appendChild(msrp);
   if(p.gw_case_pack_size>1&&p.msrp!=null){const note=document.createElement('div');note.className='form-note';note.textContent='Pack MSRP $'+money(p.msrp);msrpTd.appendChild(note)}
   const costTd=document.createElement('td'),cost=document.createElement('input');cost.type='number';cost.step='0.01';cost.min='0';cost.style.width='90px';cost.value=money(p.cost);cost.addEventListener('change',()=>patchItem(p.id,{cost:Number(cost.value)}));costTd.appendChild(cost);
   const postTd=document.createElement('td'),post=document.createElement('input');post.type='checkbox';post.checked=p.gw_post_enabled!==false;post.addEventListener('change',()=>patchItem(p.id,{gw_post_enabled:post.checked}));postTd.appendChild(post);
   if(p.gw_review_note){const n=document.createElement('div');n.className='form-note';n.textContent=p.gw_review_note;postTd.appendChild(n)}
   tr.append(nameTd,codeTd,msrpTd,costTd,postTd);table.appendChild(tr);
 }
 box.appendChild(table);
}

async function syncAndScrapeGw(){
 document.getElementById('gwSourceStatus').textContent='Syncing latest GW email, scraping form, and saving items…';
 try{
   const d=await getJson(api+'/preorders/gw/sync-draft',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({auto_submit_enabled:document.getElementById('gwAutoSubmit').checked,auto_submit_minutes_before:Number(document.getElementById('gwSubmitLeadMinutes').value||15)})});
   const c=d.campaign;document.getElementById('gwCampaignName').value=c.name||'';document.getElementById('gwFormUrl').value=c.source_form_url||'';document.getElementById('gwReleaseDate').value=String(c.release_date||'').slice(0,10);document.getElementById('gwAutoSubmit').checked=c.auto_submit_enabled!==false;setTiming(c);
   await loadGwCampaigns();document.getElementById('gwCampaignSelect').value=String(c.id);
   const full=await getJson(api+'/preorders/campaigns/'+c.id);renderCleanup(full.products);
   document.getElementById('gwSourceStatus').textContent=(d.created?'Created':'Refreshed')+' '+c.name+' · '+full.products.length+' saved item(s) · '+full.products.filter(x=>x.gw_post_enabled!==false).length+' set to post.';
   await loadGwCampaign();
 }catch(e){document.getElementById('gwSourceStatus').textContent='Sync & Scrape failed: '+e.message}
}

async function loadGwCampaign(){
 const id=document.getElementById('gwCampaignSelect').value;if(!id)return;
 const d=await getJson(api+'/preorders/campaigns/'+id),c=d.campaign;
 document.getElementById('gwCampaignName').value=c.name||'';document.getElementById('gwFormUrl').value=c.source_form_url||'';document.getElementById('gwReleaseDate').value=String(c.release_date||'').slice(0,10);document.getElementById('gwAutoSubmit').checked=c.auto_submit_enabled!==false;setTiming(c);renderCleanup(d.products);
 document.getElementById('gwSubmissionStatus').textContent='Submission: '+String(c.external_submission_status||'NOT_SUBMITTED').replaceAll('_',' ')+(c.submitted_at?' · '+new Date(c.submitted_at).toLocaleString():'');
 document.getElementById('gwCampaignStatus').textContent='Customer cutoff: '+(c.order_due_at?new Date(c.order_due_at).toLocaleString():'—')+' · GW deadline: '+(c.gw_supplier_deadline_at?new Date(c.gw_supplier_deadline_at).toLocaleString():'—')+' · Auto-submit: '+(c.gw_auto_submit_at?new Date(c.gw_auto_submit_at).toLocaleString():'—')+' · Products: '+d.products.length+' · Requests: '+d.products.reduce((n,x)=>n+Number(x.requested_total||0),0);
 document.getElementById('gwResponseStatus').textContent='Discord reactions will be recorded passively after the reaction-capture migration is enabled.';
}

function renderDiscordPreview(d){const b=document.getElementById('gwDiscordPreview');b.replaceChildren();for(const p of d.posts){const card=document.createElement('div');card.style.border='1px solid var(--border)';card.style.borderRadius='8px';card.style.padding='10px';card.style.margin='8px 0';const t=document.createElement('strong');t.textContent=p.title;const desc=document.createElement('div');desc.textContent=p.description||'';card.append(t,desc);b.appendChild(card)}}
async function previewGwDiscordPosts(){const id=document.getElementById('gwCampaignSelect').value;if(!id)return showNotice('Sync & Scrape or select a campaign first.');try{const d=await getJson(api+'/preorders/gw/campaigns/'+id+'/discord-preview');lastPreview=d;lastPreviewCampaignId=String(id);renderDiscordPreview(d);document.getElementById('gwDiscordStatus').textContent=d.counts.posts+' post(s) ready · '+d.counts.blocked+' blocked · '+d.counts.suppressed+' not posting';document.getElementById('gwPublishButton').disabled=!d.ready_to_publish}catch(e){document.getElementById('gwDiscordStatus').textContent='Preview failed: '+e.message}}
async function publishGwDiscordPosts(){const id=document.getElementById('gwCampaignSelect').value;if(!lastPreview||lastPreviewCampaignId!==String(id)||!lastPreview.ready_to_publish)return showNotice('Preview immediately before posting.');if(!confirm('Post '+lastPreview.counts.posts+' GW item(s) to Discord now?'))return;try{const d=await getJson(api+'/preorders/gw/campaigns/'+id+'/discord-publish',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({published_by:'gw-web'})});document.getElementById('gwDiscordStatus').textContent='Posted '+d.published_count+' item(s) to Discord.';document.getElementById('gwPublishButton').disabled=true;await loadGwCampaign()}catch(e){document.getElementById('gwDiscordStatus').textContent='Post failed: '+e.message}}

document.getElementById('gwSubmitLeadMinutes').value='15';
document.getElementById('accessKey').value=accessKey();setAuthState(false);
if(accessKey())saveKey();else showNotice('Enter the Special Orders access key to begin.');