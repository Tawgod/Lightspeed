const api='/api/special-orders';
let noticeTimer=null;
let lastPreviewCampaignId=null;
let lastPreview=null;

function showNotice(text,autoHideMs=0){
  const el=document.getElementById('notice');
  if(noticeTimer){clearTimeout(noticeTimer);noticeTimer=null}
  el.textContent=text;el.style.display='block';
  if(autoHideMs>0)noticeTimer=setTimeout(()=>{el.style.display='none';el.textContent='';noticeTimer=null},autoHideMs);
}
function accessKey(){return sessionStorage.getItem('hcSpecialOrdersKey')||''}
function setAuthState(ok,msg=''){
  const s=document.getElementById('authStatus');
  s.textContent=ok?'Unlocked':'Locked';
  s.style.background=ok?'#dcfce7':'#fee2e2';s.style.color=ok?'#166534':'#991b1b';
  document.querySelectorAll('button:not(#unlockButton), input:not(#accessKey), select, textarea').forEach(el=>{el.disabled=!ok});
  document.getElementById('gwPublishButton').disabled=true;
  if(msg)showNotice(msg);
}
async function getJson(url,opts={}){
  const headers={...(opts.headers||{}),'x-hobby-corner-key':accessKey()};
  const fetchOpts={...opts,headers};
  if(!fetchOpts.method || String(fetchOpts.method).toUpperCase()==='GET')fetchOpts.cache='no-store';
  const r=await fetch(url,fetchOpts);let d={};try{d=await r.json()}catch{}
  if(r.status===401){
    sessionStorage.removeItem('hcSpecialOrdersKey');
    setAuthState(false,'GW Preorders is locked. Enter the internal access key and click Unlock.');
    throw Object.assign(new Error('Access key missing or incorrect.'),{details:d,status:r.status});
  }
  if(!r.ok){const err=new Error(d.error||r.statusText);err.details=d;err.status=r.status;throw err}
  return d;
}
async function saveKey(){
  const v=document.getElementById('accessKey').value.trim();
  if(!v)return setAuthState(false,'Enter the internal access key first.');
  sessionStorage.setItem('hcSpecialOrdersKey',v);
  try{
    await getJson(api+'/auth-check');setAuthState(true,'Access key accepted. Loading GW Preorders…');
    await loadGwCampaigns();showNotice('GW Preorders ready.',1800);
  }catch(e){
    sessionStorage.removeItem('hcSpecialOrdersKey');
    setAuthState(false,e.message==='Access key missing or incorrect.'?'Access key was not accepted.':'Special Orders service is not ready: '+e.message);
  }
}
function setSourceStatus(text){document.getElementById('gwSourceStatus').textContent=text||''}
function setDiscordStatus(text){document.getElementById('gwDiscordStatus').textContent=text||''}
function resetDiscordPreview(){
  lastPreviewCampaignId=null;lastPreview=null;
  document.getElementById('gwDiscordPreview').replaceChildren();
  document.getElementById('gwPublishButton').disabled=true;setDiscordStatus('');
}
async function loadGwCampaigns(){
  const sel=document.getElementById('gwCampaignSelect'), current=sel.value;
  try{
    const rows=await getJson(api+'/preorders/campaigns?type=GW_WEEKLY');
    sel.innerHTML='<option value="">Select GW campaign…</option>';
    for(const x of rows){
      const o=document.createElement('option');o.value=x.id;
      o.textContent=(x.name||'GW campaign')+' — '+(x.external_submission_status||x.status||'OPEN');sel.appendChild(o);
    }
    if(current && Array.from(sel.options).some(o=>o.value===current))sel.value=current;
  }catch(e){document.getElementById('gwCampaignStatus').textContent='GW campaigns unavailable: '+e.message}
}
function appendSummaryTable(box,items){
  const table=document.createElement('table'), head=document.createElement('tr');
  for(const label of ['Item','Disposition','Pack','Reason']){const th=document.createElement('th');th.textContent=label;head.appendChild(th)}
  table.appendChild(head);
  for(const item of (items||[]).slice(0,120)){
    const tr=document.createElement('tr');
    for(const value of [item.name||item.item_description||'—',item.disposition||item.gw_post_disposition||'REVIEW',
      item.case_pack_size||item.gw_case_pack_size||'—',(item.reasons||[]).join('; ')||item.gw_review_note||'—']){
      const td=document.createElement('td');td.textContent=value;tr.appendChild(td);
    }
    table.appendChild(tr);
  }
  box.appendChild(table);
}
async function syncLatestGwEmail(){
  const box=document.getElementById('gwSourcePreview');setSourceStatus('Finding latest GW Want Number Form email and scraping it…');box.replaceChildren();
  try{
    const d=await getJson(api+'/preorders/gw/sync-preview'),email=d.email||{},scrape=d.scrape||{};
    if(email.form_url)document.getElementById('gwFormUrl').value=email.form_url;
    if(email.release_date)document.getElementById('gwReleaseDate').value=email.release_date.split('/').reverse().join('-');
    if(email.release_date)document.getElementById('gwCampaignName').value='GW Release '+email.release_date;
    setSourceStatus(['Latest GW email found',email.subject||'—',email.received_at?new Date(email.received_at).toLocaleString():'—',
      email.due_text?'Cutoff: '+email.due_text:'Cutoff not parsed','Scraped '+Number(scrape.counts?.items||0)+' item candidate(s)'].join(' · '));
    const summary=document.createElement('div');summary.className='form-note';
    summary.textContent=(scrape.title||'GW form')+' · '+Number(scrape.counts?.ready||0)+' ready · '+Number(scrape.counts?.review||0)+
      ' review · '+Number(scrape.counts?.filtered||0)+' filtered · '+Number(scrape.counts?.images||0)+' image(s)';
    box.appendChild(summary);appendSummaryTable(box,scrape.items||[]);
  }catch(e){
    setSourceStatus('GW email sync preview failed: '+e.message);
    const p=document.createElement('p');p.textContent='No campaign was created, no Discord post was sent, and no vendor form was submitted.';box.appendChild(p);
  }
}
async function testGwGraphMailbox(){
  const box=document.getElementById('gwSourcePreview');setSourceStatus('Testing Microsoft Graph mailbox access…');box.replaceChildren();
  try{
    const d=await getJson(api+'/preorders/gw/graph-test'),exp=d.credential_expiration||{};
    const lines=['Graph mailbox access: OK','Mailbox reference: '+(d.mailbox_reference||'unknown'),'Folder: '+(d.folder_path||'—'),
      'Matching GW messages: '+Number(d.matching_messages||0)];
    if(exp.configured&&exp.valid)lines.push('Graph secret expires: '+new Date(exp.expires_at).toLocaleDateString()+' ('+exp.days_remaining+' days remaining)');
    else if(exp.configured)lines.push('Graph secret expiration value could not be parsed.');else lines.push('Graph secret expiration tracking is not configured.');
    setSourceStatus(lines.join(' · '));
    const msgs=Array.isArray(d.messages)?d.messages:[];
    if(!msgs.length){const p=document.createElement('p');p.textContent='Graph connected successfully, but no matching Games Workshop messages were returned.';box.appendChild(p);return}
    const table=document.createElement('table'),head=document.createElement('tr');
    for(const label of ['Received','Subject','Form','Cutoff','Preorder','Release']){const th=document.createElement('th');th.textContent=label;head.appendChild(th)}
    table.appendChild(head);
    for(const m of msgs){
      const tr=document.createElement('tr');
      for(const v of [m.received_at?new Date(m.received_at).toLocaleString():'—',m.subject||'—',m.form_url?'Found':'—',m.due_text||'—',m.preorder_date||'—',m.release_date||'—']){
        const td=document.createElement('td');td.textContent=v;tr.appendChild(td);
      }table.appendChild(tr);
    }box.appendChild(table);
  }catch(e){
    const d=e.details||{},bits=['Graph mailbox test failed: '+e.message];
    if(d.stage)bits.push('Stage: '+d.stage);if(typeof d.has_mail_read==='boolean')bits.push('Token Mail.Read: '+(d.has_mail_read?'YES':'NO'));
    if(Array.isArray(d.token_roles)&&d.token_roles.length)bits.push('Token roles: '+d.token_roles.join(', '));setSourceStatus(bits.join(' · '));
  }
}
async function scrapeGwFormPreview(){
  const url=document.getElementById('gwFormUrl').value.trim(),box=document.getElementById('gwSourcePreview');
  if(!url)return showNotice('Paste the GW Want Number Form URL first.');box.textContent='Scraping GW form…';
  try{
    const d=await getJson(api+'/preorders/gw/scrape-preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({source_url:url})});
    box.replaceChildren();const summary=document.createElement('div');summary.className='form-note';
    summary.textContent=(d.title||'GW form')+' · '+d.counts.items+' item candidate(s) · '+d.counts.ready+' ready · '+d.counts.review+
      ' review · '+d.counts.filtered+' filtered · '+d.counts.images+' image(s)';box.appendChild(summary);
    if(!d.items.length){const p=document.createElement('p');p.textContent='No product candidates were extracted. Questions found: '+d.counts.questions+'.';box.appendChild(p);return}
    appendSummaryTable(box,d.items);
  }catch(e){box.textContent='Scrape failed: '+e.message}
}
async function importLatestGwDraft(){
  setSourceStatus('Importing latest GW email and scraped products as a draft…');
  try{
    const d=await getJson(api+'/preorders/gw/sync-draft',{method:'POST'});await loadGwCampaigns();
    document.getElementById('gwCampaignSelect').value=String(d.campaign.id);
    setSourceStatus((d.created?'Created':'Updated')+' GW draft · '+d.products.total+' product(s) · '+Number(d.scrape_counts?.ready||0)+
      ' ready · '+Number(d.scrape_counts?.review||0)+' review · '+Number(d.scrape_counts?.filtered||0)+' filtered');await loadGwCampaign();
  }catch(e){setSourceStatus('GW draft import failed: '+e.message)}
}
async function updateGwProductReview(id,patch){
  try{
    await getJson(api+'/preorders/gw/products/'+id,{method:'PATCH',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({...patch,gw_reviewed_by:'gw-web'})});
    resetDiscordPreview();showNotice('GW product review saved.',1000);
  }catch(e){showNotice('Could not save GW product review: '+e.message);throw e}
}
function renderGwCampaignProducts(products){
  const box=document.getElementById('gwCampaignProducts');box.replaceChildren();
  if(!products.length){const p=document.createElement('p');p.textContent='No products in this GW campaign yet.';box.appendChild(p);return}
  const table=document.createElement('table'),head=document.createElement('tr');
  for(const label of ['Image','Item','Disposition','Pack','Single item name','Single MSRP','Review note']){const th=document.createElement('th');th.textContent=label;head.appendChild(th)}
  table.appendChild(head);
  for(const item of products){
    const tr=document.createElement('tr'),imageTd=document.createElement('td'),imageUrl=item.image_url||item.source_image_url||'';
    if(imageUrl){const img=document.createElement('img');img.src=imageUrl;img.alt=item.item_description||'GW product';img.loading='lazy';img.style.width='72px';
      img.style.height='72px';img.style.objectFit='contain';img.onerror=()=>{img.style.display='none'};imageTd.appendChild(img)}else imageTd.textContent='—';
    const name=document.createElement('td');name.textContent=item.item_description||'—';
    const dispTd=document.createElement('td'),sel=document.createElement('select');
    for(const value of ['REVIEW','POST_AS_IS','SPLIT_TO_SINGLES','DO_NOT_POST']){
      const o=document.createElement('option');o.value=value;o.textContent=value.replaceAll('_',' ');if(value===item.gw_post_disposition)o.selected=true;sel.appendChild(o)}
    sel.addEventListener('change',()=>updateGwProductReview(item.id,{gw_post_disposition:sel.value}));dispTd.appendChild(sel);
    const packTd=document.createElement('td'),pack=document.createElement('input');pack.type='number';pack.min='1';pack.style.width='5rem';pack.value=item.gw_case_pack_size||'';
    pack.addEventListener('change',()=>updateGwProductReview(item.id,{gw_case_pack_size:pack.value?Number(pack.value):null}));packTd.appendChild(pack);
    const singleNameTd=document.createElement('td'),singleName=document.createElement('input');singleName.value=item.gw_single_item_name||'';singleName.placeholder='Optional';
    singleName.addEventListener('change',()=>updateGwProductReview(item.id,{gw_single_item_name:singleName.value}));singleNameTd.appendChild(singleName);
    const singleMsrpTd=document.createElement('td'),singleMsrp=document.createElement('input');singleMsrp.type='number';singleMsrp.min='0';singleMsrp.step='0.01';
    singleMsrp.style.width='7rem';singleMsrp.value=item.gw_single_msrp??'';
    singleMsrp.addEventListener('change',()=>updateGwProductReview(item.id,{gw_single_msrp:singleMsrp.value===''?null:Number(singleMsrp.value)}));singleMsrpTd.appendChild(singleMsrp);
    const noteTd=document.createElement('td'),note=document.createElement('input');note.value=item.gw_review_note||'';note.placeholder='Why flagged / instructions';
    note.addEventListener('change',()=>updateGwProductReview(item.id,{gw_review_note:note.value}));noteTd.appendChild(note);
    tr.append(imageTd,name,dispTd,packTd,singleNameTd,singleMsrpTd,noteTd);table.appendChild(tr);
  }box.appendChild(table);
}
async function createGwCampaign(){
  const name=document.getElementById('gwCampaignName').value.trim(),sourceFormUrl=document.getElementById('gwFormUrl').value.trim(),due=document.getElementById('gwOrderDue').value;
  if(!name||!sourceFormUrl||!due)return showNotice('Campaign name, GW form URL, and order cutoff are required.');
  try{
    const row=await getJson(api+'/preorders/gw/campaigns',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({name,source_form_url:sourceFormUrl,order_due_at:new Date(due).toISOString(),release_date:document.getElementById('gwReleaseDate').value||null,
        auto_submit_enabled:Boolean(document.getElementById('gwAutoSubmit').checked),auto_submit_minutes_before:15})});
    showNotice('GW preorder campaign created.',1800);await loadGwCampaigns();document.getElementById('gwCampaignSelect').value=String(row.id);await loadGwCampaign();
  }catch(e){showNotice('Could not create GW campaign: '+e.message)}
}
async function loadGwCampaign(){
  const id=document.getElementById('gwCampaignSelect').value,status=document.getElementById('gwCampaignStatus');resetDiscordPreview();
  if(!id){status.textContent='';document.getElementById('gwCampaignProducts').replaceChildren();return}
  try{
    const d=await getJson(api+'/preorders/campaigns/'+id),c=d.campaign;
    status.textContent='Cutoff: '+(c.order_due_at?new Date(c.order_due_at).toLocaleString():'—')+' · Products: '+d.products.length+
      ' · Requests: '+d.products.reduce((n,x)=>n+Number(x.requested_total||0),0)+' · '+(c.external_submission_status||'NOT_SUBMITTED')+
      (c.discord_published_at?' · Discord published '+new Date(c.discord_published_at).toLocaleString():'')+
      (c.auto_submit_enabled?' · Auto-submit requested (currently safety-disabled)':'');renderGwCampaignProducts(d.products);
  }catch(e){status.textContent='GW campaign load failed: '+e.message}
}
function renderDiscordPreview(d){
  const box=document.getElementById('gwDiscordPreview');box.replaceChildren();
  if(d.blocked.length){const warn=document.createElement('div');warn.className='notice';warn.textContent='Blocked: '+d.blocked.map(x=>'#'+x.product_id+' '+x.reason).join(' | ');box.appendChild(warn)}
  for(const post of d.posts){
    const card=document.createElement('div');card.style.border='1px solid var(--border, #777)';card.style.borderRadius='8px';card.style.padding='12px';card.style.margin='10px 0';
    const title=document.createElement('strong');title.textContent=post.title;card.appendChild(title);
    const desc=document.createElement('pre');desc.style.whiteSpace='pre-wrap';desc.style.margin='8px 0';desc.textContent=post.description||'';card.appendChild(desc);
    if(post.image_url){const img=document.createElement('img');img.src=post.image_url;img.alt=post.title;img.loading='lazy';img.style.maxWidth='320px';img.style.maxHeight='240px';
      img.style.objectFit='contain';img.style.display='block';img.style.margin='8px 0';img.onerror=()=>{img.style.display='none'};card.appendChild(img)}
    const footer=document.createElement('div');footer.className='form-note';footer.textContent=post.footer+(post.image_url?' · image attached':' · no image');card.appendChild(footer);box.appendChild(card);
  }
  if(d.suppressed.length){const p=document.createElement('p');p.className='form-note';p.textContent=d.suppressed.length+' product(s) are intentionally suppressed and will not be posted.';box.appendChild(p)}
}
async function previewGwDiscordPosts(){
  const id=document.getElementById('gwCampaignSelect').value;if(!id)return showNotice('Select a GW campaign first.');
  setDiscordStatus('Building Discord preview…');document.getElementById('gwPublishButton').disabled=true;
  try{
    const d=await getJson(api+'/preorders/gw/campaigns/'+id+'/discord-preview');lastPreview=d;lastPreviewCampaignId=String(id);renderDiscordPreview(d);
    const pub=d.publication,pubText=pub?' · Publication status: '+pub.status+(pub.published_at?' at '+new Date(pub.published_at).toLocaleString():''):'';
    setDiscordStatus('Discord preview for channel '+(d.test_channel_id||'not configured')+' · '+d.counts.posts+' post(s) · '+d.counts.blocked+' blocked · '+
      d.counts.suppressed+' suppressed · '+(d.ready_to_publish?'Ready to publish':'Not ready to publish')+pubText);
    document.getElementById('gwPublishButton').disabled=!(d.ready_to_publish && !pub);
  }catch(e){setDiscordStatus('Discord preview failed: '+e.message)}
}
async function publishGwDiscordPosts(){
  const id=document.getElementById('gwCampaignSelect').value;
  if(!id||lastPreviewCampaignId!==String(id)||!lastPreview?.ready_to_publish)return showNotice('Preview this campaign immediately before publishing.');
  if(lastPreview.publication)return showNotice('This campaign already has a Discord publication record.');
  const count=Number(lastPreview.counts?.posts||0);
  if(!window.confirm('Publish '+count+' approved GW preorder post(s) to Discord channel '+lastPreview.test_channel_id+' now?'))return;
  const button=document.getElementById('gwPublishButton');button.disabled=true;setDiscordStatus('Publishing '+count+' approved GW preorder post(s)…');
  try{
    const d=await getJson(api+'/preorders/gw/campaigns/'+id+'/discord-publish',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({published_by:'gw-web'})});
    setDiscordStatus('Published '+d.published_count+' GW preorder post(s) to Discord. Publication ID '+d.publication_id+'.');
    showNotice('GW preorder posts published to Discord.',2500);await loadGwCampaign();await previewGwDiscordPosts();
  }catch(e){
    const details=e.details||{},extra=details.published_count!=null?' '+details.published_count+' post(s) were sent before the failure.':'';
    setDiscordStatus('Discord publish failed: '+e.message+extra);showNotice('Discord publish did not complete. Review the status before retrying.');
  }
}

document.getElementById('accessKey').value=accessKey();setAuthState(false);
if(accessKey())saveKey();else showNotice('GW Preorders is locked. Enter the internal access key above and click Unlock.');
