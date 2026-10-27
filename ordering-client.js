const api='/api/special-orders';
let workRows=[],suppliers=[],lsContext={purchase_orders:[],lightspeed_demand:[]},recommendations=new Map();

function accessKey(){return sessionStorage.getItem('hcSpecialOrdersKey')||''}
function showNotice(t){const e=document.getElementById('notice');e.textContent=t;e.style.display='block'}
function esc(v){return String(v??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]))}
function money(v){return v==null||v===''?'—':'$'+Number(v).toFixed(2)}
function setAuth(ok){document.getElementById('authStatus').textContent=ok?'Unlocked':'Locked';document.querySelectorAll('button:not(#unlockButton),select').forEach(e=>e.disabled=!ok)}

async function getJson(url,opts={}){
  const r=await fetch(url,{...opts,headers:{...(opts.headers||{}),'x-hobby-corner-key':accessKey()},cache:'no-store'});
  let d={};try{d=await r.json()}catch{}
  if(r.status===401){setAuth(false);throw new Error('Access key missing or incorrect.')}
  if(!r.ok){const e=new Error(d.error||r.statusText);e.details=d;throw e}
  return d
}

async function saveKey(){
  const v=document.getElementById('accessKey').value.trim();if(!v)return;
  sessionStorage.setItem('hcSpecialOrdersKey',v);
  try{await getJson(api+'/auth-check');setAuth(true);await refreshEverything()}
  catch(e){sessionStorage.removeItem('hcSpecialOrdersKey');showNotice(e.message)}
}

async function refreshEverything(){
  try{
    showNotice('Refreshing Lightspeed suppliers, purchase orders, fulfillment demand, and Special Orders…');
    await loadSuppliers();
    await Promise.all([loadOrdering(),loadLightspeedContext(),loadReadyNotifications(),loadDeliveryQueue()]);
    showNotice('Ordering data refreshed.');
  }catch(e){showNotice('Refresh failed: '+e.message)}
}

async function loadSuppliers(){
  suppliers=await getJson(api+'/suppliers');
  const s=document.getElementById('supplierFilter'),cur=s.value;
  s.innerHTML='<option value="">All suppliers</option>'+suppliers.map(x=>'<option value="'+x.id+'">'+esc(x.name)+'</option>').join('');
  if(cur&&suppliers.some(x=>String(x.id)===String(cur)))s.value=cur;
}

function fillCategoryFilter(){
  const s=document.getElementById('categoryFilter'),cur=s.value;
  const cats=[...new Set(workRows.map(r=>r.product_category||r.category_name).filter(Boolean))].sort((a,b)=>String(a).localeCompare(String(b)));
  s.innerHTML='<option value="">All categories</option>'+cats.map(x=>'<option value="'+esc(x)+'">'+esc(x)+'</option>').join('');
  if(cur&&cats.includes(cur))s.value=cur;
}

async function loadOrdering(){
  const d=await getJson(api+'/ordering/work-queue?view=general&status=ALL');
  workRows=d.rows||[];
  fillCategoryFilter();
  applyFilters();
}

function poText(row){
  const pos=Array.isArray(row.purchase_orders)?row.purchase_orders:[];
  if(!pos.length)return '<span class="form-note">Not on current PO</span>';
  return pos.map(x=>'<b>'+esc(x.purchase_order_number||x.purchase_order_id)+'</b> · '+esc(x.status||'')).join('<br>');
}

function supplierOptions(row){
  return '<option value="">Unassigned</option>'+suppliers.map(s=>'<option value="'+s.id+'" '+(String(s.id)===String(row.preferred_supplier_id||'')?'selected':'')+'>'+esc(s.name)+'</option>').join('');
}

async function setPreferredSupplier(id,supplierId){
  try{
    await getJson(api+'/items/'+id+'/routing',{
      method:'PATCH',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({preferred_supplier_id:supplierId||null,changed_by:'ordering-web'})
    });
    recommendations.delete(Number(id));
    showNotice('Preferred supplier updated.');
    await loadOrdering();
  }catch(e){showNotice('Could not update supplier: '+e.message)}
}

async function recommendSupplier(rowId,productId){
  if(!productId)return showNotice('This line is not linked to a Lightspeed/local product yet, so a supplier recommendation is not available.');
  try{
    const rows=await getJson(api+'/products/'+productId+'/recommended-suppliers');
    recommendations.set(Number(rowId),rows.slice(0,3));
    applyFilters();
  }catch(e){showNotice('Could not load recommendations: '+e.message)}
}

async function useRecommendation(rowId,supplierId){
  await setPreferredSupplier(rowId,supplierId);
}

function recommendationHtml(row){
  const recs=recommendations.get(Number(row.id));
  if(!recs){
    return row.product_id
      ? '<button class="secondary-button" onclick="recommendSupplier('+row.id+','+row.product_id+')">Suggest</button>'
      : '<span class="form-note">No matched product</span>';
  }
  if(!recs.length)return '<span class="form-note">No recommendation yet</span>';
  return recs.map((r,i)=>
    '<div style="margin-bottom:4px">'+
      (i===0?'★ ':'')+'<b>'+esc(r.name)+'</b>'+
      ' <button class="secondary-button" onclick="useRecommendation('+row.id+','+r.id+')">Use</button>'+
      '<div class="form-note">'+esc(r.recommendation_reason||'')+'</div>'+
    '</div>'
  ).join('');
}

async function updateLineStatus(id,status){
  try{
    await getJson(api+'/items/'+id+'/status',{
      method:'PATCH',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({status,changed_by:'ordering-web'})
    });
    showNotice('Line updated to '+status+'.');
    await loadOrdering();
  }catch(e){showNotice('Status update failed: '+e.message)}
}

function toggleNotes(id,checked){
  const box=document.getElementById('notes-box-'+id);
  if(box)box.style.display=checked?'block':'none';
}
async function saveNotes(id){
  const input=document.getElementById('notes-'+id);
  try{
    await getJson(api+'/items/'+id+'/notes',{
      method:'PATCH',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({notes:input.value,changed_by:'ordering-web'})
    });
    const row=workRows.find(x=>Number(x.id)===Number(id));if(row)row.notes=input.value;
    showNotice('Line notes saved.');
  }catch(e){showNotice('Could not save notes: '+e.message)}
}

function ageDays(createdAt){
  if(!createdAt)return 0;
  return Math.max(0,Math.floor((Date.now()-new Date(createdAt).getTime())/86400000));
}
function ageClass(days){
  if(days>=14)return 'ordering-age-red';
  if(days>=7)return 'ordering-age-orange';
  if(days>=3)return 'ordering-age-yellow';
  return 'ordering-age-green';
}
function ageLabel(days){
  if(days===0)return 'Today';
  return days+' day'+(days===1?'':'s');
}
async function toggleActivity(id){
  const box=document.getElementById('activity-box-'+id);
  if(!box)return;
  if(box.dataset.loaded==='1'){
    box.style.display=box.style.display==='none'?'block':'none';
    return;
  }
  box.style.display='block';
  box.innerHTML='<div class="form-note">Loading history…</div>';
  try{
    const d=await getJson(api+'/items/'+id+'/activity');
    const rows=d.activities||[];
    if(!rows.length){
      box.innerHTML='<div class="form-note">No recorded activity yet.</div>';
    }else{
      box.innerHTML=rows.map(a=>{
        const when=a.created_at?new Date(a.created_at).toLocaleString():'Unknown time';
        const by=a.changed_by?' · '+esc(a.changed_by):'';
        let detail='';
        if(a.activity_type==='STATUS')detail=esc((a.old_value||'—')+' → '+(a.new_value||'—'));
        else if(a.activity_type==='NOTE')detail=esc(a.new_value||a.message||'');
        else if(a.activity_type==='SUPPLIER')detail=esc((a.old_value||'Unassigned')+' → '+(a.new_value||'Unassigned'));
        else detail=esc(a.message||'');
        return '<div class="ordering-log-entry"><b>'+esc(a.activity_type)+'</b> · '+esc(when)+by+
          '<div>'+detail+'</div>'+
          (a.message && a.activity_type!=='NOTE' && a.activity_type!=='STATUS' && a.activity_type!=='SUPPLIER'
            ? '<div class="form-note">'+esc(a.message)+'</div>':'')+
          '</div>';
      }).join('');
    }
    box.dataset.loaded='1';
  }catch(e){
    box.innerHTML='<div class="form-note">Could not load history: '+esc(e.message)+'</div>';
  }
}

function filteredRows(){
  const supplier=document.getElementById('supplierFilter').value;
  const category=document.getElementById('categoryFilter').value;
  const status=document.getElementById('statusFilter').value;
  const sort=document.getElementById('sortMode').value;
  let rows=workRows.filter(r=>
    (!supplier||String(r.preferred_supplier_id||'')===String(supplier))&&
    (!category||String(r.product_category||r.category_name||'')===String(category))&&
    (status==='ALL'||String(r.status)===status)
  );
  const cmp={
    supplier:(a,b)=>String(a.preferred_supplier_name||'ZZZ').localeCompare(String(b.preferred_supplier_name||'ZZZ')),
    category:(a,b)=>String(a.product_category||a.category_name||'ZZZ').localeCompare(String(b.product_category||b.category_name||'ZZZ')),
    status:(a,b)=>String(a.status).localeCompare(String(b.status)),
    customer:(a,b)=>String(a.customer_name||'').localeCompare(String(b.customer_name||'')),
    oldest:(a,b)=>new Date(a.created_at)-new Date(b.created_at)
  }[sort];
  return rows.sort(cmp);
}

function applyFilters(){
  const rows=filteredRows(),box=document.getElementById('orderingRows');
  box.replaceChildren();
  document.getElementById('orderingSummary').textContent=
    rows.length+' of '+workRows.length+' Special Order line(s) shown · '+
    rows.filter(x=>x.on_current_purchase_order).length+' currently found on a Lightspeed PO.';
  if(!rows.length){box.innerHTML='<p class="form-note">No lines match these filters.</p>';return}

  const table=document.createElement('table');
  table.innerHTML='<tr><th>Age</th><th>Customer</th><th>Item</th><th>Qty</th><th>Supplier</th><th>Recommendation</th><th>Category</th><th>LS PO#</th><th>Status</th><th>Notes / Log</th></tr>';
  for(const r of rows){
    const tr=document.createElement('tr');
    const days=ageDays(r.created_at);
    tr.classList.add(ageClass(days));
    tr.innerHTML=
      '<td><b>'+ageLabel(days)+'</b><div class="form-note">'+esc(r.created_at?new Date(r.created_at).toLocaleDateString():'—')+'</div></td>'+
      '<td>'+esc(r.customer_name||'—')+'</td>'+
      '<td><b>'+esc(r.requested_name)+'</b><div class="form-note">'+esc([r.requested_sku,r.supplier_sku].filter(Boolean).join(' / ')||'No SKU')+'</div></td>'+
      '<td>'+Number(r.quantity||0)+'</td>'+
      '<td><select id="supplier-'+r.id+'">'+supplierOptions(r)+'</select></td>'+
      '<td id="recommend-'+r.id+'">'+recommendationHtml(r)+'</td>'+
      '<td>'+esc(r.product_category||r.category_name||'Unassigned')+'</td>'+
      '<td>'+poText(r)+'</td>'+
      '<td><select id="status-'+r.id+'">'+
        ['PREORDER','OOS','READY_TO_ORDER','ORDERED','BACKORDERED','RECEIVED','HELD','CUSTOMER_NOTIFIED','COMPLETED','CANCELLED']
        .map(s=>'<option value="'+s+'" '+(s===r.status?'selected':'')+'>'+s.replaceAll('_',' ')+'</option>').join('')+
      '</select></td>'+
      '<td><label><input id="notes-toggle-'+r.id+'" type="checkbox" '+(r.notes?'checked':'')+'> Notes</label> '+
        '<button class="secondary-button" onclick="toggleActivity('+r.id+')">Log</button>'+
        '<div id="notes-box-'+r.id+'" style="display:'+(r.notes?'block':'none')+';margin-top:6px">'+
          '<textarea id="notes-'+r.id+'" rows="2" style="min-width:220px">'+esc(r.notes||'')+'</textarea><br>'+
          '<button class="secondary-button" onclick="saveNotes('+r.id+')">Save note</button>'+
        '</div>'+
        '<div id="activity-box-'+r.id+'" class="ordering-activity-log" style="display:none"></div></td>';
    tr.querySelector('#supplier-'+r.id).addEventListener('change',e=>setPreferredSupplier(r.id,e.target.value));
    tr.querySelector('#status-'+r.id).addEventListener('change',e=>updateLineStatus(r.id,e.target.value));
    tr.querySelector('#notes-toggle-'+r.id).addEventListener('change',e=>toggleNotes(r.id,e.target.checked));
    table.appendChild(tr);
  }
  box.appendChild(table);
}

function clearFilters(){
  document.getElementById('supplierFilter').value='';
  document.getElementById('categoryFilter').value='';
  document.getElementById('statusFilter').value='ALL';
  document.getElementById('sortMode').value='oldest';
  applyFilters();
}

async function loadLightspeedContext(){
  try{
    lsContext=await getJson(api+'/ordering/lightspeed-context');
    renderLightspeedDemand();
    renderPurchaseOrders();
  }catch(e){
    document.getElementById('lightspeedDemandStatus').textContent='Lightspeed demand unavailable: '+e.message;
    document.getElementById('lightspeedPoStatus').textContent='Lightspeed purchase orders unavailable: '+e.message;
  }
}

function toggleLsCustomer(key){
  const el=document.getElementById('ls-customer-'+key);
  if(el)el.style.display=el.style.display==='none'?'block':'none';
}

function customerContactHtml(r,index){
  const key=String(index);
  const details=[r.customer_email,r.customer_phone].filter(Boolean).map(esc).join('<br>');
  return '<button class="secondary-button" onclick="toggleLsCustomer(\''+key+'\')">'+esc(r.customer_name||'Lightspeed customer')+'</button>'+
    '<div id="ls-customer-'+key+'" style="display:none;margin-top:5px" class="form-note">'+
      (details||'No email/phone returned by Lightspeed')+
    '</div>';
}

function runOrderingCheck(productId,sku){
  document.getElementById('supplierFilter').value='';
  document.getElementById('categoryFilter').value='';
  document.getElementById('statusFilter').value='ALL';
  document.getElementById('sortMode').value='oldest';
  applyFilters();
  const match=workRows.find(r=>
    String(r.lightspeed_product_id||'')===String(productId||'') ||
    (sku && String(r.requested_sku||r.supplier_sku||'').toUpperCase()===String(sku).toUpperCase())
  );
  document.getElementById('orderingRows').scrollIntoView({behavior:'smooth',block:'start'});
  if(match){
    showNotice('Ordering check: found matching Special Order line #'+match.id+' for '+match.requested_name+'.');
    setTimeout(()=>{
      const sel=document.getElementById('supplier-'+match.id);
      const row=sel?.closest('tr');
      if(row){row.style.outline='3px solid #f59e0b';setTimeout(()=>row.style.outline='',4000)}
    },250);
  }else{
    showNotice('Ordering check: no matching local Special Order line was found. Review the Lightspeed demand and current PO status before ordering.');
  }
}

function renderLightspeedDemand(){
  const rows=Array.isArray(lsContext.lightspeed_demand)?lsContext.lightspeed_demand:[];
  document.getElementById('lightspeedDemandStatus').textContent=
    rows.length+' product line(s) found across '+Number(lsContext.fulfillment_count||0)+' open fulfillment(s).';
  const box=document.getElementById('lightspeedDemand');box.replaceChildren();
  if(!rows.length){box.innerHTML='<p class="form-note">No open Lightspeed fulfillment demand was returned.</p>';return}
  const table=document.createElement('table');
  table.innerHTML='<tr><th></th><th>Customer</th><th>Sale</th><th>Item</th><th>SKU / UPC</th><th>Qty</th><th>LS PO#</th><th>Ordering Check</th></tr>';
  rows.forEach((r,index)=>{
    const tr=document.createElement('tr');
    const po=(r.purchase_orders||[]).length
      ? r.purchase_orders.map(x=>'<b>'+esc(x.purchase_order_number||x.purchase_order_id)+'</b> · '+esc(x.status||'')).join('<br>')
      : '<span class="pill">Not on current PO</span>';
    const image=r.image_url
      ? '<img src="'+esc(r.image_url)+'" alt="" style="width:48px;height:48px;object-fit:contain;border-radius:6px">'
      : '<span class="form-note">No image</span>';
    const local=r.local_special_order_match_count
      ? '<div class="form-note">'+r.local_special_order_match_count+' local Special Order match'+(r.local_special_order_match_count===1?'':'es')+'</div>'
      : '<div class="form-note">No local Special Order match</div>';
    tr.innerHTML=
      '<td>'+image+'</td>'+
      '<td>'+customerContactHtml(r,index)+'</td>'+
      '<td>'+esc(r.invoice_number||r.sale_id)+'</td>'+
      '<td><b>'+esc(r.item_description)+'</b>'+local+'</td>'+
      '<td>'+esc([r.sku,r.upc].filter(Boolean).join(' / ')||'—')+'</td>'+
      '<td>'+Number(r.quantity||0)+'</td>'+
      '<td>'+po+'</td>'+
      '<td><button onclick="runOrderingCheck(\''+esc(String(r.product_id||''))+'\',\''+esc(String(r.sku||''))+'\')">Ordering Check</button></td>';
    table.appendChild(tr);
  });
  box.appendChild(table);
}

function renderPurchaseOrders(){
  const rows=Array.isArray(lsContext.purchase_orders)?lsContext.purchase_orders:[];
  document.getElementById('lightspeedPoStatus').textContent=rows.length+' current Lightspeed purchase order(s).';
  const box=document.getElementById('lightspeedPurchaseOrders');box.replaceChildren();
  if(!rows.length){box.innerHTML='<p class="form-note">No current Lightspeed purchase orders were returned.</p>';return}
  const table=document.createElement('table');
  table.innerHTML='<tr><th>PO</th><th>Status</th><th>Supplier</th><th>Lines</th><th>Special Orders</th><th>Updated</th></tr>';
  const supplierByLs=new Map(suppliers.map(s=>[String(s.lightspeed_supplier_id||''),s.name]));
  const receivingSelect=document.getElementById('receivingPoSelect');
  const currentReceiving=receivingSelect?.value||'';
  if(receivingSelect){
    receivingSelect.innerHTML='<option value="">Select current Lightspeed PO…</option>'+
      rows.map(po=>'<option value="'+esc(po.id)+'">'+esc(po.reference||po.order_number||po.number||po.name||po.id)+' · '+esc(po.status||'')+'</option>').join('');
    if(currentReceiving&&rows.some(po=>String(po.id)===String(currentReceiving)))receivingSelect.value=currentReceiving;
  }
  for(const po of rows){
    const supplierId=String(po.supplier_id||po.supplier?.id||'');
    const ref=po.reference||po.order_number||po.number||po.name||po.id;
    const tr=document.createElement('tr');
    tr.innerHTML=
      '<td><b>'+esc(ref)+'</b></td>'+
      '<td>'+esc(po.status||'—')+'</td>'+
      '<td>'+esc(supplierByLs.get(supplierId)||po.supplier?.name||'—')+'</td>'+
      '<td>'+Number((po.line_items||[]).length)+'</td>'+
      '<td><b>'+Number(po.special_order_count||0)+'</b><div class="form-note">'+Number(po.special_order_units||0)+' customer unit(s)</div></td>'+
      '<td>'+esc(po.updated_at?new Date(po.updated_at).toLocaleString():'—')+'</td>';
    table.appendChild(tr);
  }
  box.appendChild(table);
}
async function loadReceivingPreview(){
  const poId=document.getElementById('receivingPoSelect').value;
  const box=document.getElementById('receivingRows');
  box.replaceChildren();
  if(!poId){document.getElementById('receivingSummary').textContent='Select a current Lightspeed PO.';return}
  try{
    const d=await getJson(api+'/ordering/lightspeed-purchase-orders/'+encodeURIComponent(poId)+'/receiving-preview');
    document.getElementById('receivingSummary').textContent='PO '+(d.purchase_order.reference||d.purchase_order.id)+' · '+d.lines.length+' product line(s). Enter cumulative customer quantity allocated from this PO.';
    const table=document.createElement('table');
    table.innerHTML='<tr><th>Product</th><th>PO Qty</th><th>LS Received</th><th>Customer</th><th>Needed</th><th>This PO Allocated</th><th>Confirm Target</th></tr>';
    let detailCount=0;
    for(const line of d.lines){
      const waiting=(line.waiting_special_orders||[]).filter(x=>Number(x.remaining_needed||0)>0||Number(x.this_po_allocated||0)>0);
      if(!waiting.length)continue;
      waiting.forEach((w,index)=>{
        detailCount++;
        const tr=document.createElement('tr');
        tr.innerHTML=
          '<td>'+(index===0?('<b>'+esc(line.product_name)+'</b><div class="form-note">'+esc(line.sku||'')+'</div>'):'')+'</td>'+
          '<td>'+(index===0?Number(line.ordered_quantity||0):'')+'</td>'+
          '<td>'+(index===0?Number(line.lightspeed_received_quantity||0):'')+'</td>'+
          '<td><b>'+esc(w.customer_name||'Customer')+'</b><div class="form-note">'+esc([w.customer_email,w.customer_phone].filter(Boolean).join(' · '))+'</div></td>'+
          '<td>'+Number(w.remaining_needed||0)+' of '+Number(w.quantity||0)+'</td>'+
          '<td>'+Number(w.this_po_allocated||0)+'</td>'+
          '<td><input id="receive-target-'+w.special_order_item_id+'" type="number" min="'+Number(w.this_po_allocated||0)+'" max="'+Number(w.quantity||0)+'" step="1" value="'+Number(w.this_po_allocated||0)+'" style="width:75px"></td>';
        table.appendChild(tr);
      });
    }
    if(!detailCount){box.innerHTML='<p class="form-note">No waiting Special Orders match products on this PO.</p>';return}
    box.appendChild(table);
    const button=document.createElement('button');
    button.textContent='Confirm Special Order Receiving';
    button.style.marginTop='10px';
    button.onclick=()=>confirmReceiving(poId,d);
    box.appendChild(button);
  }catch(e){showNotice('Could not load receiving review: '+e.message)}
}

async function confirmReceiving(poId,preview){
  const allocations=[];
  for(const line of preview.lines||[]){
    for(const w of line.waiting_special_orders||[]){
      const el=document.getElementById('receive-target-'+w.special_order_item_id);
      if(!el)continue;
      const target=Math.max(0,Math.floor(Number(el.value)||0));
      if(target!==Number(w.this_po_allocated||0))allocations.push({special_order_item_id:w.special_order_item_id,target_allocated_quantity:target});
    }
  }
  if(!allocations.length)return showNotice('No receiving quantities changed.');
  if(!confirm('Confirm '+allocations.length+' Special Order receiving allocation(s)? This updates Special Orders locally and creates customer notification review items. It does not change Lightspeed inventory.'))return;
  try{
    const d=await getJson(api+'/ordering/lightspeed-purchase-orders/'+encodeURIComponent(poId)+'/receive-special-orders',{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({allocations,received_by:'ordering-web'})
    });
    const ready=(d.outcomes||[]).filter(x=>x.ready).length;
    showNotice('Receiving saved. '+ready+' Special Order line(s) are fully received.');
    await Promise.all([loadReceivingPreview(),loadOrdering(),loadReadyNotifications(),loadDeliveryQueue()]);
  }catch(e){showNotice('Receiving failed: '+e.message)}
}

async function loadReadyNotifications(){
  try{
    const rows=await getJson(api+'/notifications/ready-review');
    document.getElementById('readyNotificationSummary').textContent=rows.length+' customer notification review item(s).';
    const box=document.getElementById('readyNotifications');box.replaceChildren();
    if(!rows.length){box.innerHTML='<p class="form-note">No customer-ready notifications need review.</p>';return}
    const table=document.createElement('table');
    table.innerHTML='<tr><th>Customer</th><th>Item</th><th>Received</th><th>Contact</th><th>Message</th><th>Review</th></tr>';
    for(const n of rows){
      const tr=document.createElement('tr');
      const contact=[n.discord_user_id?'Discord linked':null,n.email||null,n.phone||null].filter(Boolean).join(' · ')||'No contact method on file';
      tr.innerHTML=
        '<td><b>'+esc(n.customer_name||'Customer')+'</b></td>'+
        '<td>'+esc(n.requested_name||'')+' · Qty '+Number(n.quantity||0)+'</td>'+
        '<td>'+esc(n.received_at?new Date(n.received_at).toLocaleString():'—')+'</td>'+
        '<td>'+esc(contact)+'</td>'+
        '<td>'+esc(n.message||'')+'</td>'+
        '<td><button onclick="reviewNotification('+n.id+',\'ACKNOWLEDGED\')">Approve</button> '+
          '<button class="secondary-button" onclick="reviewNotification('+n.id+',\'SUPPRESSED\')">Suppress</button></td>';
      table.appendChild(tr);
    }
    box.appendChild(table);
  }catch(e){showNotice('Could not load notification review: '+e.message)}
}

async function reviewNotification(id,action){
  let reason=null;
  if(action==='SUPPRESSED'){reason=prompt('Reason for suppressing this notification:','Customer already contacted');if(reason===null)return}
  try{
    await getJson(api+'/notifications/'+id+'/review',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,reason,reviewed_by:'ordering-web'})});
    showNotice(action==='ACKNOWLEDGED'?'Notification approved for delivery queue.':'Notification suppressed.');
    await Promise.all([loadReadyNotifications(),loadDeliveryQueue()]);
  }catch(e){showNotice('Notification review failed: '+e.message)}
}
async function loadDeliveryQueue(){
  try{
    const rows=await getJson(api+'/notifications/delivery-queue');
    document.getElementById('deliveryQueueSummary').textContent=rows.length+' approved delivery item(s) waiting/in progress/error.';
    const box=document.getElementById('deliveryQueue');box.replaceChildren();
    if(!rows.length){box.innerHTML='<p class="form-note">No approved customer messages are waiting for delivery.</p>';return}
    const table=document.createElement('table');
    table.innerHTML='<tr><th>Customer</th><th>Item</th><th>Channel</th><th>Recipient</th><th>Status</th><th>Queued</th><th>Error</th></tr>';
    for(const n of rows){
      const tr=document.createElement('tr');
      tr.innerHTML=
        '<td>'+esc(n.customer_name||'Customer')+'</td>'+
        '<td>'+esc(n.requested_name||'')+'</td>'+
        '<td><b>'+esc(String(n.channel||'').replace('_READY',''))+'</b></td>'+
        '<td>'+esc(n.recipient||'—')+'</td>'+
        '<td>'+esc(n.status||'')+'</td>'+
        '<td>'+esc(n.created_at?new Date(n.created_at).toLocaleString():'—')+'</td>'+
        '<td>'+esc(n.error||'')+'</td>';
      table.appendChild(tr);
    }
    box.appendChild(table);
  }catch(e){showNotice('Could not load delivery queue: '+e.message)}
}
document.getElementById('accessKey').value=accessKey();setAuth(false);
if(accessKey())saveKey();