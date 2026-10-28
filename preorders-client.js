const api='/api/special-orders';
function accessKey(){return window.HCStaffAuth?.legacyKey?.()||''}
function authHeaders(extra={}){return window.HCStaffAuth?.headers?.(extra)||{...extra}}
function authEmployee(){return window.HCStaffAuth?.employee?.()||null}
function showNotice(t){const e=document.getElementById('notice');e.textContent=t;e.style.display='block'}
function setAuth(ok){
  document.getElementById('authStatus').textContent=ok?'Unlocked':'Locked';
  document.querySelectorAll('button:not(#unlockButton):not(#legacyUnlockButton):not(#signOutButton),select').forEach(e=>e.disabled=!ok);
  const signOut=document.getElementById('signOutButton');
  if(signOut)signOut.style.display=ok&&authEmployee()?'inline-block':'none';
  const identity=document.getElementById('authEmployee');
  if(identity)identity.textContent=authEmployee()?.name?'Signed in as '+authEmployee().name:'';
}
async function getJson(url,opts={}){
  const r=await fetch(url,{...opts,headers:authHeaders(opts.headers||{}),cache:'no-store'});
  let d={};try{d=await r.json()}catch{}
  if(r.status===401){
    window.HCStaffAuth?.signOut?.();
    setAuth(false);
    throw new Error('Employee sign-in required.');
  }
  if(!r.ok)throw new Error(d.error||r.statusText);
  return d
}
async function staffSignIn(){
  const pin=document.getElementById('employeePin').value.trim();
  if(!pin)return showNotice('Enter your 4-digit Timeclock PIN.');
  try{
    const session=await window.HCStaffAuth.signIn(pin);
    document.getElementById('employeePin').value='';
    setAuth(true);
    showNotice('Signed in as '+(session.employee?.name||'employee')+'.');
    await Promise.all([loadPreorders(),loadDiscordWatch()]);
  }catch(e){setAuth(false);showNotice(e.message)}
}
function staffSignOut(){window.HCStaffAuth?.signOut?.();setAuth(false);showNotice('Signed out.')}
async function saveKey(){
  const v=document.getElementById('accessKey').value.trim();if(!v)return;
  window.HCStaffAuth?.setLegacyKey?.(v);
  try{await getJson(api+'/auth-check');setAuth(true);await Promise.all([loadPreorders(),loadDiscordWatch()])}
  catch(e){window.HCStaffAuth?.setLegacyKey?.('');setAuth(false);showNotice(e.message)}
}
function esc(v){return String(v??'').replace(/[&<>\"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[ch]))}
function watchCustomerLabel(w){
  if(w.customer_name)return '<b>'+esc(w.customer_name)+'</b><div class="form-note">'+esc([w.customer_email,w.customer_phone].filter(Boolean).join(' · ')||w.discord_display_name||w.discord_username||'Discord customer')+'</div>';
  return '<b>'+esc(w.discord_display_name||w.discord_username||'Discord user')+'</b><div class="form-note">No customer match yet</div>';
}
async function updateWatch(id,patch){
  try{
    await getJson(api+'/preorders/discord-watch/'+id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(patch)});
    showNotice('Preorder watch updated.');
    await loadDiscordWatch();
  }catch(e){showNotice('Could not update watch item: '+e.message)}
}
async function saveWatchNotes(id){const el=document.getElementById('watch-notes-'+id);await updateWatch(id,{notes:el.value})}
async function saveWatchItemText(id){const el=document.getElementById('watch-item-'+id);await updateWatch(id,{item_text:el.value})}
async function loadDiscordWatch(){
  try{
    const status=document.getElementById('watchStatus').value||'WATCHING';
    const rows=await getJson(api+'/preorders/discord-watch?status='+encodeURIComponent(status));
    document.getElementById('watchSummary').textContent=rows.length+' Discord preorder watch item(s).';
    const box=document.getElementById('discordWatch');box.replaceChildren();
    if(!rows.length){box.innerHTML='<p class="form-note">No watch items in this status.</p>';return}
    const table=document.createElement('table');
    table.innerHTML='<tr><th>Captured</th><th>Customer</th><th>Item / request</th><th>Source</th><th>Mode</th><th>Status</th><th>Notes</th></tr>';
    for(const w of rows){
      const tr=document.createElement('tr');
      const link=w.message_url?'<a href="'+esc(w.message_url)+'" target="_blank" rel="noopener">Open Discord message</a>':'<span class="form-note">No message link</span>';
      const source='<div>'+link+'</div><div class="form-note">'+esc(w.channel_name?('#'+w.channel_name):'Discord')+'</div>';
      const confidence=w.confidence==null?'':(' · '+Math.round(Number(w.confidence)*100)+'%');
      tr.innerHTML=
        '<td>'+esc(new Date(w.captured_at).toLocaleString())+'</td>'+
        '<td>'+watchCustomerLabel(w)+'</td>'+
        '<td><textarea id="watch-item-'+w.id+'" rows="2" style="min-width:260px">'+esc(w.item_text)+'</textarea><br>'+
          '<button class="secondary-button" onclick="saveWatchItemText('+w.id+')">Save item text</button>'+
          (w.message_text?'<details><summary>Original message</summary><div class="form-note">'+esc(w.message_text)+'</div></details>':'')+
        '</td>'+
        '<td>'+source+'</td>'+
        '<td><b>'+esc(w.capture_mode)+'</b><div class="form-note">'+esc(w.discord_username||'')+confidence+'</div></td>'+
        '<td><select onchange="updateWatch('+w.id+',{status:this.value})">'+
          ['WATCHING','AVAILABLE','CONVERTED','DISMISSED'].map(s=>'<option value="'+s+'" '+(s===w.status?'selected':'')+'>'+s.replaceAll('_',' ')+'</option>').join('')+
        '</select></td>'+
        '<td><textarea id="watch-notes-'+w.id+'" rows="2" style="min-width:220px">'+esc(w.notes||'')+'</textarea><br>'+
          '<button class="secondary-button" onclick="saveWatchNotes('+w.id+')">Save notes</button></td>';
      table.appendChild(tr);
    }
    box.appendChild(table);
  }catch(e){showNotice('Could not load Discord preorder watch: '+e.message)}
}
async function loadPreorders(){const c=await getJson(api+'/preorders/campaigns');document.getElementById('preorderCampaign').innerHTML='<option value="">Select preorder campaign…</option>'+c.map(x=>'<option value="'+x.id+'">'+x.name+' — '+x.request_count+' requests</option>').join('')}
async function loadPreorderCampaign(){const id=document.getElementById('preorderCampaign').value;document.getElementById('allocationSuggestions').innerHTML='';if(!id){document.getElementById('preorderProducts').innerHTML='';return}try{const d=await getJson(api+'/preorders/campaigns/'+id);document.getElementById('campaignSummary').textContent='Status: '+(d.campaign.status||'—')+' · Due: '+(d.campaign.order_due_at?new Date(d.campaign.order_due_at).toLocaleString():'—')+' · Release: '+(d.campaign.release_date||'—');document.getElementById('preorderProducts').innerHTML='<table><tr><th>Product</th><th>Ordered</th><th>Received</th><th>Requested</th><th>Allocated</th><th>Available</th><th>Actions</th></tr>'+d.products.map(x=>{const a=Math.max(0,Number(x.received_quantity||0)-Number(x.reserved_floor_quantity||0)-Number(x.allocated_total||0));return '<tr><td>'+x.item_description+'</td><td>'+x.ordered_quantity+'</td><td>'+x.received_quantity+'</td><td>'+x.requested_total+'</td><td>'+x.allocated_total+'</td><td>'+a+'</td><td><button onclick="showAllocationSuggestions('+x.id+','+a+')">Suggested</button> <button onclick="allocatePreorder('+x.id+',\'FAIR_SHARE\')">Fair share</button> <button onclick="allocatePreorder('+x.id+',\'QUEUE\')">Queue</button></td></tr>'}).join('')+'</table>'}catch(e){showNotice(e.message)}}
async function showAllocationSuggestions(id,available){const box=document.getElementById('allocationSuggestions');box.innerHTML='<p>Calculating suggested allocation…</p>';try{const d=await getJson(api+'/preorders/products/'+id+'/allocation-suggestions?available_quantity='+encodeURIComponent(available)+'&refresh_lightspeed=1');const rows=d.suggestions||[];box.innerHTML='<h3>Suggested allocation <span class="pill">Advisory only</span></h3>'+(!rows.length?'<p>No unallocated requests.</p>':'<table><tr><th>Rank</th><th>Customer</th><th>Score</th><th>Suggested Qty</th><th>History</th><th>Flags</th></tr>'+rows.map((x,i)=>'<tr><td>'+(i+1)+'</td><td>'+(x.customer_name||x.discord_handle||'Customer')+'</td><td><b>'+x.allocation_score+'</b></td><td>'+x.suggested_quantity+'</td><td>'+(x.picked_up||0)+' picked up · '+(x.late_pickups||0)+' late · '+(x.no_pickups||0)+' missed</td><td>'+((x.flags||[]).join('; ')||'—')+'</td></tr>').join('')+'</table>')}catch(e){box.innerHTML='';showNotice(e.message)}}
async function allocatePreorder(id,method){if(!confirm('Allocate currently available inventory using '+method+'?'))return;try{const d=await getJson(api+'/preorders/products/'+id+'/allocate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method})});showNotice('Allocated '+d.newlyAllocated+'; '+d.remaining+' still available.');await loadPreorderCampaign()}catch(e){showNotice(e.message)}}
async function initializeAuth(){
  document.getElementById('accessKey').value=accessKey();
  setAuth(false);
  const existing=await window.HCStaffAuth?.verify?.();
  if(existing){setAuth(true);await Promise.all([loadPreorders(),loadDiscordWatch()]);return}
  if(accessKey())await saveKey();
  else showNotice('Preorder Campaigns is locked. Sign in with your Timeclock PIN.');
}
initializeAuth();