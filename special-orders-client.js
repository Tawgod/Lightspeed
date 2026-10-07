const api='/api/special-orders';
let selectedCustomer=null, selectedOrderProduct=null, stagedItems=[];
let allSuppliers=[], editingStagedIndex=null;
let autoRefreshTimer=null;
const ORDER_DRAFT_KEY='hcSpecialOrderDraftV2';
const PRODUCT_DRAFT_KEY='hcCreateProductDraftV1';

const orderDraftIds=[
  'customerSearch','customerPhone','customerEmail','customerDiscord','customerNotes','orderNotes',
  'newProductSearch','manualItemName','manualSku','orderQty','newStatus',
  'newDepartment','newSupplier','supplierNeeded','newNotes','crowdfundingNote','sourceUrl'
];
const productDraftIds=[
  'cpName','cpSku','cpProductCode','cpCost','cpRetail','cpCategorySearch','cpSupplier',
  'cpSupplierSku','cpDescription','cpSourceUrl','cpImageUrl','cpOrderChannel'
];

function readField(id){
  const el=document.getElementById(id); if(!el)return null;
  if(el.type==='checkbox')return el.checked;
  if(el.multiple)return Array.from(el.selectedOptions).map(o=>o.value);
  return el.value;
}
function writeField(id,value){
  const el=document.getElementById(id); if(!el || value==null)return;
  if(el.type==='checkbox'){el.checked=Boolean(value);return}
  if(el.multiple){
    const vals=new Set(Array.isArray(value)?value:[]);
    Array.from(el.options).forEach(o=>o.selected=vals.has(o.value)); return;
  }
  el.value=String(value);
}
function saveDrafts(){
  const order={};
  orderDraftIds.forEach(id=>order[id]=readField(id));
  order.newSuppliers=readField('newSuppliers');
  order.selectedCustomer=selectedCustomer;
  order.selectedOrderProduct=selectedOrderProduct;
  order.stagedItems=stagedItems;
  localStorage.setItem(ORDER_DRAFT_KEY,JSON.stringify(order));

  const product={};
  productDraftIds.forEach(id=>product[id]=readField(id));
  product.cpCategory=readField('cpCategory');
  localStorage.setItem(PRODUCT_DRAFT_KEY,JSON.stringify(product));
}
function restoreDrafts(){
  try{
    const order=JSON.parse(localStorage.getItem(ORDER_DRAFT_KEY)||'null');
    if(order){
      orderDraftIds.forEach(id=>writeField(id,order[id]));
      writeField('newSuppliers',order.newSuppliers);
      selectedCustomer=order.selectedCustomer||null;
      selectedOrderProduct=order.selectedOrderProduct||null;
      stagedItems=Array.isArray(order.stagedItems)?order.stagedItems:[];
      if(selectedCustomer){
        showSelectedCustomer();
        document.getElementById('customerProfile').style.display='block';
      }
      if(selectedOrderProduct){
        document.getElementById('selectedProduct').textContent=(selectedOrderProduct.name||'Product')+(selectedOrderProduct.sku?' — '+selectedOrderProduct.sku:'');
      }
      renderStagedItems();
    }
    const product=JSON.parse(localStorage.getItem(PRODUCT_DRAFT_KEY)||'null');
    if(product){
      productDraftIds.forEach(id=>writeField(id,product[id]));
      writeField('cpCategory',product.cpCategory);
      if(product.cpCategory && allProductCategories.length)setSelectedCategory(product.cpCategory);
      updateDetectedProductCode();
    }
  }catch(e){console.warn('Could not restore saved form drafts',e)}
}
function showNewCustomer(){
  document.getElementById('newCustomerPanel').style.display='block';
  document.getElementById('customerResults').innerHTML='';
}
function hideNewCustomer(){
  document.getElementById('newCustomerPanel').style.display='none';
}
async function createNewCustomer(){
  const first=document.getElementById('ncFirstName').value.trim();
  const last=document.getElementById('ncLastName').value.trim();
  if(!first||!last)return showNotice('First and last name are required.');
  const payload={
    first_name:first,
    last_name:last,
    phone:document.getElementById('ncPhone').value.trim()||null,
    email:document.getElementById('ncEmail').value.trim()||null,
    discord_handle:document.getElementById('ncDiscord').value.trim()||null,
    notes:document.getElementById('ncNotes').value.trim()||null
  };
  try{
    const r=await getJson(api+'/customers/create-lightspeed',{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)
    });
    const c=r.lightspeed||{};
    selectedCustomer={
      ...c,
      id:c.id,
      first_name:c.first_name||first,
      last_name:c.last_name||last,
      mobile:payload.phone,
      email:payload.email,
      discord_handle:payload.discord_handle,
      special_orders_phone:payload.phone,
      special_orders_notes:payload.notes,
      local_customer_id:r.local?.id||null
    };
    showSelectedCustomer();
    document.getElementById('customerProfile').style.display='block';
    document.getElementById('customerPhone').value=payload.phone||'';
    document.getElementById('customerDiscord').value=payload.discord_handle||'';
    document.getElementById('customerNotes').value=payload.notes||'';
    ['ncFirstName','ncLastName','ncPhone','ncEmail','ncDiscord','ncNotes'].forEach(id=>document.getElementById(id).value='');
    hideNewCustomer();
    saveDrafts();
    showNotice('New Lightspeed customer created and selected.',2500);
  }catch(e){showNotice('Customer creation failed: '+e.message)}
}
function showSelectedCustomer(){
  if(!selectedCustomer)return;
  const name=[selectedCustomer.first_name,selectedCustomer.last_name].filter(Boolean).join(' ')||selectedCustomer.company_name||selectedCustomer.name||'Selected customer';
  document.getElementById('selectedCustomer').textContent=name;
}
function clearCurrentItem(){
  selectedOrderProduct=null;
  editingStagedIndex=null;
  ['newProductSearch','manualItemName','manualSku','newNotes','crowdfundingNote','sourceUrl'].forEach(id=>writeField(id,''));
  writeField('orderQty','1');writeField('newStatus','OOS');writeField('newDepartment','');writeField('newSupplier','');
  writeField('newSuppliers',[]);writeField('supplierNeeded',false);
  document.getElementById('selectedProduct').textContent='No product selected';
  document.getElementById('newProductResults').innerHTML='';
  document.getElementById('addItemButton').textContent='Add item to order';
  renderItemSupplierOptions(allSuppliers);
  document.getElementById('itemEditor').style.display='none';
  saveDrafts();
}
function clearOrderForm(){
  selectedCustomer=null;selectedOrderProduct=null;stagedItems=[];
  ['customerSearch','customerFirstName','customerLastName','customerCompany','customerPhone','customerEmail','customerDiscord','customerNotes','customerAddress1','customerAddress2','customerCity','customerState','customerPostcode','orderNotes'].forEach(id=>writeField(id,''));
  document.getElementById('selectedCustomer').textContent='No customer selected';
  document.getElementById('customerProfile').style.display='none';
  document.getElementById('customerResults').innerHTML='';
  clearCurrentItem();
  renderStagedItems();
  localStorage.removeItem(ORDER_DRAFT_KEY);
}
function clearProductForm(){
  productDraftIds.forEach(id=>writeField(id,''));
  writeField('cpCategory','');
  writeField('cpOrderChannel','TRADE');
  document.getElementById('categoryBreadcrumb').textContent='No category selected';
  document.getElementById('categoryMatches').innerHTML='';
  document.getElementById('createProductResult').innerHTML='';
  updateDetectedProductCode();
  renderCategoryLevels(null);
  localStorage.removeItem(PRODUCT_DRAFT_KEY);
}
function showItemEditor(){
  if(!selectedCustomer)return showNotice('Select a customer first.');
  if(editingStagedIndex==null)renderItemSupplierOptions(allSuppliers);
  document.getElementById('createProductPanel').style.display='none';
  document.getElementById('itemEditor').style.display='block';
}
function showCreateProduct(){
  if(!selectedCustomer)return showNotice('Select a customer first.');
  document.getElementById('itemEditor').style.display='none';
  document.getElementById('createProductPanel').style.display='block';
}
function hideCreateProduct(){
  document.getElementById('createProductPanel').style.display='none';
}
function cleanStagedName(value){
  const s=String(value||'').trim();
  const lower=s.toLowerCase();
  if(lower.startsWith('quick add — '))return s.slice(12).trim();
  if(lower.startsWith('quick add - '))return s.slice(12).trim();
  return s;
}
function renderStagedItems(){
  const el=document.getElementById('stagedItems');
  if(!stagedItems.length){el.innerHTML='<p style="color:#6b7280">No items added yet.</p>';return}
  el.innerHTML='<table><tr><th>Item</th><th>SKU</th><th>Qty</th><th>Status</th><th>Supplier</th><th>Details</th><th></th></tr>'+
    stagedItems.map((x,i)=>`<tr>
      <td>${x.requested_name||x.name||'—'}</td>
      <td>${x.requested_sku||'—'}</td>
      <td><input type="number" min="1" value="${x.quantity||1}" style="width:64px" onchange="updateStagedQty(${i},this.value)"></td>
      <td><span class="pill">${x.status||'OOS'}</span></td>
      <td>${x.preferred_supplier_name||'—'}</td>
      <td>${x.needs_details?'<span class="pill" style="background:#fff4df;color:#92400e">Needs details</span>':'Ready'}</td>
      <td><button type="button" onclick="editStagedItem(${i})">Edit</button> <button type="button" onclick="removeStagedItem(${i})">Remove</button></td>
    </tr>`).join('')+
    '</table>';
}
function updateStagedQty(i,value){
  const qty=Math.max(1,parseInt(value,10)||1);
  if(!stagedItems[i])return;
  stagedItems[i].quantity=qty;
  saveDrafts();
}
function removeStagedItem(i){
  if(editingStagedIndex===i)editingStagedIndex=null;
  else if(editingStagedIndex!=null && editingStagedIndex>i)editingStagedIndex--;
  stagedItems.splice(i,1);renderStagedItems();saveDrafts();
}
async function quickAddItem(){
  if(!selectedCustomer)return showNotice('Select a customer first.');
  const input=document.getElementById('quickAddItem');
  const value=input.value.trim();
  if(!value)return;
  input.disabled=true;
  try{
    const matches=await findProductMatches([value]);
    const exact=matches.find(x=>x._exact);
    if(exact){
      selectedOrderProduct=exact;
      document.getElementById('manualItemName').value=exact.name||value;
      document.getElementById('manualSku').value=exact.sku||value;
      document.getElementById('orderQty').value='1';
      document.getElementById('newStatus').value='OOS';
      await rankSuppliersForProduct(exact);
      addCurrentItem();
      input.value='';
      showNotice('Quick Add matched '+(exact.name||value)+' and added the existing product.',2000);
      return;
    }
    const codeLike=looksLikeCode(value);
    stagedItems.push({
      product_id:null,lightspeed_product_id:null,requested_name:value,requested_sku:codeLike?value:null,
      quantity:1,status:'OOS',sourcing_department_id:null,preferred_supplier_id:null,preferred_supplier_name:null,
      supplier_ids:[],supplier_needed:false,notes:null,crowdfunding_note:null,source_url:null,
      placeholder_product:true,needs_details:true,quick_add:true
    });
    input.value='';
    renderStagedItems();saveDrafts();
    showNotice('No exact identifier match found. Added as Needs details so you can match or create the product.',2200);
  }catch(e){showNotice('Quick Add lookup failed: '+e.message)}
  finally{input.disabled=false;input.focus()}
}
async function editStagedItem(i){
  const x=stagedItems[i]; if(!x)return;
  editingStagedIndex=i;
  selectedOrderProduct=x.product_id||x.lightspeed_product_id ? {
    local_id:x.product_id||null,
    lightspeed_product_id:x.lightspeed_product_id||null,
    id:x.lightspeed_product_id||null,
    name:x.requested_name,
    sku:x.requested_sku
  } : null;
  document.getElementById('itemEditor').style.display='block';
  document.getElementById('createProductPanel').style.display='none';
  const inferredSearch=x.requested_sku||cleanStagedName(x.requested_name);
  writeField('newProductSearch',inferredSearch);
  writeField('manualItemName',cleanStagedName(x.requested_name));
  writeField('manualSku',x.requested_sku||'');
  writeField('orderQty',x.quantity||1);
  writeField('newStatus',x.status||'OOS');
  writeField('newDepartment',x.sourcing_department_id||'');
  writeField('supplierNeeded',Boolean(x.supplier_needed));
  writeField('newNotes',x.notes||'');
  writeField('crowdfundingNote',x.crowdfunding_note||'');
  writeField('sourceUrl',x.source_url||'');
  document.getElementById('selectedProduct').textContent=selectedOrderProduct
    ? ((selectedOrderProduct.name||'Product')+(selectedOrderProduct.sku?' — '+selectedOrderProduct.sku:''))
    : 'Unmatched item';
  await rankSuppliersForProduct(selectedOrderProduct,x.preferred_supplier_id,x.supplier_ids||[]);
  document.getElementById('addItemButton').textContent='Update item';
  if(!selectedOrderProduct)await openProductMatchModal(inferredSearch);
  else document.getElementById('itemEditor').scrollIntoView({behavior:'smooth',block:'center'});
}
function addCurrentItem(){
  if(!selectedCustomer)return showNotice('Select a customer first.');
  const itemName=document.getElementById('manualItemName').value.trim()||(selectedOrderProduct&&selectedOrderProduct.name);
  const sku=document.getElementById('manualSku').value.trim()||selectedOrderProduct?.sku||null;
  if(!itemName && !sku)return showNotice('Select an item or enter at least a name/SKU.');
  const preferredSupplierId=document.getElementById('newSupplier').value||null;
  const preferredSupplierOption=document.getElementById('newSupplier').selectedOptions[0];
  const preferredSupplier=allSuppliers.find(s=>String(s.id)===String(preferredSupplierId));
  const item={
    product_id:selectedOrderProduct?.local_id||selectedOrderProduct?.local?.id||null,
    lightspeed_product_id:selectedOrderProduct?.lightspeed_product_id||selectedOrderProduct?.id||null,
    requested_name:itemName||sku,
    requested_sku:sku,
    quantity:Number(document.getElementById('orderQty').value||1),
    status:document.getElementById('newStatus').value,
    sourcing_department_id:document.getElementById('newDepartment').value||null,
    preferred_supplier_id:preferredSupplierId,
    preferred_supplier_name:preferredSupplierId?(preferredSupplier?.name||preferredSupplierOption?.textContent||null):null,
    supplier_ids:Array.from(document.getElementById('newSuppliers').selectedOptions).map(o=>o.value),
    supplier_needed:document.getElementById('supplierNeeded').checked,
    notes:document.getElementById('newNotes').value.trim()||null,
    crowdfunding_note:document.getElementById('crowdfundingNote').value.trim()||null,
    source_url:document.getElementById('sourceUrl').value.trim()||null,
    placeholder_product:!selectedOrderProduct,
    needs_details:false,
    quick_add:false
  };
  if(editingStagedIndex!=null){
    stagedItems[editingStagedIndex]=item;
    editingStagedIndex=null;
    showNotice('Item updated.',1600);
  }else{
    stagedItems.push(item);
    showNotice('Item added to this order.',1600);
  }
  renderStagedItems();
  clearCurrentItem();
  saveDrafts();
}
async function configureAutoRefresh(){
  try{
    const r=await fetch(api+'/health');const h=await r.json();
    if(autoRefreshTimer){clearInterval(autoRefreshTimer);autoRefreshTimer=null}
    if(h.liveMode){
      autoRefreshTimer=setInterval(()=>{if(accessKey()){loadStats();loadOrders();loadSuppliers();}},60000);
    }
  }catch{}
}
let noticeTimer=null;
function showNotice(t,autoHideMs=0){
  const n=document.getElementById('notice');
  if(noticeTimer){clearTimeout(noticeTimer);noticeTimer=null}
  n.textContent=t;n.style.display='block';
  if(autoHideMs>0)noticeTimer=setTimeout(()=>{n.style.display='none';n.textContent='';noticeTimer=null},autoHideMs);
}
function accessKey(){return sessionStorage.getItem('hcSpecialOrdersKey')||''}
function setAuthState(ok,msg=''){
  const s=document.getElementById('authStatus');
  s.textContent=ok?'Unlocked':'Locked';
  s.style.background=ok?'#dcfce7':'#fee2e2';
  s.style.color=ok?'#166534':'#991b1b';
  document.querySelectorAll('button:not(#unlockButton), input:not(#accessKey), select, textarea').forEach(el=>{
    if(el.id==='legacyWorkbook') return;
    el.disabled=!ok;
  });
  if(msg)showNotice(msg);
}
async function saveKey(){
  const v=document.getElementById('accessKey').value.trim();
  if(!v)return setAuthState(false,'Enter the internal access key first.');
  sessionStorage.setItem('hcSpecialOrdersKey',v);
  try{
    await getJson(api+'/auth-check');
    setAuthState(true,'Access key accepted. Loading Special Orders…');
    await loadAll();
    restoreDrafts();
    showNotice('Special Orders ready.',2500);
    configureAutoRefresh();
  }catch(e){
    sessionStorage.removeItem('hcSpecialOrdersKey');
    setAuthState(false,e.message==='Access key missing or incorrect.'
      ? 'Access key was not accepted. Please re-enter the test access key.'
      : 'Access key accepted, but the Special Orders service is not ready: '+e.message);
  }
}
async function getJson(url,opts={}){
  const headers={...(opts.headers||{}),'x-hobby-corner-key':accessKey()};
  const fetchOpts={...opts,headers};
  if(!fetchOpts.method || String(fetchOpts.method).toUpperCase()==='GET')fetchOpts.cache='no-store';
  const r=await fetch(url,fetchOpts);let d={};try{d=await r.json()}catch{}
  if(r.status===401){
    sessionStorage.removeItem('hcSpecialOrdersKey');
    setAuthState(false,'Special Orders is locked. Enter the internal access key and click Unlock.');
    throw new Error('Access key missing or incorrect.');
  }
  if(!r.ok)throw new Error(d.error||r.statusText);return d
}
async function importWorkbook(){
  const f=document.getElementById('legacyWorkbook').files[0];if(!f)return showNotice('Choose the HC Special Orders workbook first.');
  const fd=new FormData();fd.append('workbook',f);
  try{
    const r=await fetch(api+'/import/workbook',{method:'POST',headers:{'x-hobby-corner-key':accessKey()},body:fd});
    const d=await r.json();if(!r.ok)throw new Error(d.error||r.statusText);
    showNotice(d.alreadyImported?'That exact workbook has already been imported.':`Imported ${d.imported} rows. Skipped ${d.skipped} duplicates.`);
    await loadStats();await loadOrders();
  }catch(e){showNotice(e.message)}
}
async function loadStats(){try{const s=await getJson(api+'/stats');for(const k of Object.keys(s))if(document.getElementById(k))document.getElementById(k).textContent=s[k]}catch(e){showNotice(e.message)}}
async function loadOrders(){try{
  const p=new URLSearchParams();
  const st=document.getElementById('statusFilter').value;if(st)p.set('status',st);
  if(document.getElementById('attention').checked)p.set('attention','1');
  const rows=await getJson(api+'/orders?'+p);
  document.getElementById('orders').innerHTML=rows.map(x=>`<tr>
    <td>${x.customer_name||'—'}</td>
    <td>${x.product_name||x.requested_name}</td>
    <td>${x.sku||x.requested_sku||'—'}</td>
    <td><input type="number" min="1" value="${x.quantity}" style="width:62px" onchange="updateSubmittedQty(${x.id},this.value,this)"></td>
    <td><span class="pill">${x.status}</span></td>
    <td>${x.preferred_supplier_name||'—'}</td>
    <td class="${x.days_ordered>=7?'danger':''}">${x.days_ordered==null?'—':x.days_ordered+'d'}</td>
    <td>${x.notes||''}</td>
    <td><button type="button" onclick="removeSubmittedItem(${x.id},'${String(x.product_name||x.requested_name||'item').replace(/'/g,"\\'")}')">Remove</button></td>
  </tr>`).join('');
}catch(e){showNotice(e.message)}}
async function updateSubmittedQty(id,value,input){
  const qty=Math.max(1,parseInt(value,10)||1);
  input.disabled=true;
  try{
    const r=await getJson(api+'/items/'+encodeURIComponent(id),{
      method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({quantity:qty})
    });
    input.value=r.quantity;
    showNotice('Quantity updated.',1400);
  }catch(e){
    showNotice('Could not update quantity: '+e.message);
    await loadOrders();
  }finally{input.disabled=false}
}
async function removeSubmittedItem(id,name){
  if(!confirm('Remove '+name+' from this special order?'))return;
  try{
    await getJson(api+'/items/'+encodeURIComponent(id),{method:'DELETE'});
    showNotice('Item removed from the special order.',1600);
    await loadOrders();await loadStats();
  }catch(e){showNotice('Could not remove item: '+e.message)}
}
function supplierOptionLabel(x){
  const prefix=x.recommendation_rank===0?'★ ':x.recommendation_rank===1?'◆ ':x.recommendation_rank===2?'• ':'';
  return prefix+x.name+(x.recommendation_reason?' — '+x.recommendation_reason:'');
}
function renderItemSupplierOptions(list=allSuppliers,preferredValue=null,otherValues=[]){
  const preferred=document.getElementById('newSupplier');
  const others=document.getElementById('newSuppliers');
  preferred.innerHTML='<option value="">Preferred supplier (optional)…</option>'+list.map(x=>`<option value="${x.id}">${supplierOptionLabel(x)}</option>`).join('');
  others.innerHTML=list.map(x=>`<option value="${x.id}">${supplierOptionLabel(x)}</option>`).join('');
  if(preferredValue)preferred.value=String(preferredValue);
  const selected=new Set((otherValues||[]).map(String));
  Array.from(others.options).forEach(o=>o.selected=selected.has(String(o.value)));
}
async function rankSuppliersForProduct(product,preferredValue=null,otherValues=[]){
  if(product?.local_id){
    try{
      const ranked=await getJson(api+'/products/'+encodeURIComponent(product.local_id)+'/recommended-suppliers');
      let autoPreferred=preferredValue;
      if(!autoPreferred){
        const exact=ranked.find(x=>Number(x.recommendation_rank)===0);
        if(exact)autoPreferred=exact.id;
      }
      renderItemSupplierOptions(ranked,autoPreferred,otherValues);
      return ranked;
    }catch(e){console.warn('Supplier recommendation load failed',e)}
  }
  renderItemSupplierOptions(allSuppliers,preferredValue,otherValues);
  return allSuppliers;
}
async function loadSuppliers(){try{
  const s=await getJson(api+'/suppliers');
  allSuppliers=s;
  document.getElementById('supplierSelect').innerHTML='<option value="">Order a supplier…</option>'+s.map(x=>`<option value="${x.id}">${x.name}</option>`).join('');
  renderItemSupplierOptions(s);
  document.getElementById('cpSupplier').innerHTML='<option value="">Primary supplier (optional)</option>'+s.map(x=>`<option value="${x.id}">${x.name}</option>`).join('');
}catch(e){
document.getElementById('cpSupplier').innerHTML='<option value="">Supplier load failed</option>';
document.getElementById('newSupplier').innerHTML='<option value="">Supplier load failed</option>';
showNotice('Could not load suppliers: '+e.message)}}
async function loadDepartments(){try{const d=await getJson(api+'/departments');document.getElementById('departmentSelect').innerHTML='<option value="">Source by department…</option>'+d.map(x=>`<option value="${x.id}">${x.name} (${x.supplier_count})</option>`).join('');document.getElementById('newDepartment').innerHTML='<option value="">Sourcing department…</option>'+d.map(x=>`<option value="${x.id}">${x.name}</option>`).join('')}catch(e){}}
async function loadDepartment(){const id=document.getElementById('departmentSelect').value;if(!id){document.getElementById('departmentResults').innerHTML='';return}try{const r=await getJson(api+'/departments/'+id+'/suppliers');document.getElementById('departmentResults').innerHTML='<h3>Possible suppliers for this department</h3><p style="color:#6b7280">These are sourcing possibilities even when the product is not currently linked to that supplier in Lightspeed.</p>'+(!r.length?'<p>No suppliers are tagged for this department yet.</p>':'<table><tr><th>Supplier</th><th>Typical cadence</th><th>Known product link?</th><th>Supplier SKU</th><th>Cost</th></tr>'+r.map(x=>`<tr><td>${x.name}</td><td>${x.order_frequency||'—'}</td><td>${x.exact_product_mapping?'Yes':'Possible source'}</td><td>${x.supplier_sku||'—'}</td><td>${x.supply_price||'—'}</td></tr>`).join('')+'</table>')}catch(e){showNotice(e.message)}}
async function loadSupplier(){
  const id=document.getElementById('supplierSelect').value;
  const box=document.getElementById('supplierResults');
  if(!id){box.innerHTML='';window._supplierOrderable=[];return}
  box.innerHTML='<p>Loading supplier order needs…</p>';
  try{
    window._supplierOrderable=await getJson(api+'/suppliers/'+id+'/orderable');
    renderSupplierOrderBuilder();
  }catch(e){showNotice(e.message)}
}
function renderSupplierOrderBuilder(){
  const rows=window._supplierOrderable||[];
  const box=document.getElementById('supplierResults');
  const supplier=document.getElementById('supplierSelect').selectedOptions[0]?.textContent||'Supplier';
  if(!rows.length){
    box.innerHTML='<h3>Supplier Order Builder — '+supplier+'</h3><p>Nothing is currently waiting to be ordered from this supplier.</p>';
    return;
  }
  let html='<div class="section-heading"><div><h3>Supplier Order Builder — '+supplier+'</h3>';
  html+='<p class="form-note">Builds a local draft PO. It will not send anything to Lightspeed while setup mode is active.</p></div><span class="pill">Draft only</span></div>';
  html+='<div class="form-grid form-grid-2"><label class="field"><span>Supplier order / reference #</span><input id="supplierOrderNumber" placeholder="Optional"></label><label class="field"><span>PO notes</span><input id="supplierOrderNotes" placeholder="Optional notes for this order"></label></div>';
  html+='<table><tr><th>Order?</th><th>Item</th><th>Supplier SKU</th><th>SO Needed</th><th>Customers</th><th>Floor Add</th><th>Total Qty</th><th>Unit Cost</th><th>Est. Total</th></tr>';
  rows.forEach((x,i)=>{
    const needed=Math.max(0,Number(x.qty_needed||0));
    const cost=Number(x.supply_price||0);
    html+='<tr><td><input id="poInclude-'+i+'" type="checkbox" checked onchange="updateSupplierOrderTotals()"></td>';
    html+='<td>'+(x.name||'—')+'</td><td>'+(x.supplier_sku||'—')+'</td><td>'+needed+'</td><td>'+(x.waiting_orders||0)+'</td>';
    html+='<td><input id="poFloor-'+i+'" type="number" min="0" value="0" style="width:74px" oninput="updateSupplierOrderTotals()"></td>';
    html+='<td id="poQty-'+i+'">'+needed+'</td><td>'+(cost?'$'+cost.toFixed(2):'—')+'</td><td id="poTotal-'+i+'">'+(cost?'$'+(needed*cost).toFixed(2):'—')+'</td></tr>';
  });
  html+='</table><div class="toolbar" style="margin-top:12px;justify-content:flex-end"><strong id="supplierOrderGrandTotal">Estimated total: —</strong><button type="button" onclick="createSupplierOrderDraft()">Save draft supplier order</button></div><div id="supplierOrderDraftResult"></div>';
  box.innerHTML=html;
  updateSupplierOrderTotals();
}
function supplierOrderDraftLines(){
  const rows=window._supplierOrderable||[];
  return rows.map((x,i)=>{
    const include=document.getElementById('poInclude-'+i)?.checked;
    const specialQty=Math.max(0,Number(x.qty_needed||0));
    const floorQty=Math.max(0,Number(document.getElementById('poFloor-'+i)?.value||0));
    return {
      include,product_id:x.product_id,quantity:specialQty+floorQty,
      unit_cost:x.supply_price==null?null:Number(x.supply_price),
      special_order_quantity:specialQty,floor_quantity:floorQty,
      placeholder_name:x.name||null,placeholder_sku:x.supplier_sku||x.sku||null
    };
  }).filter(x=>x.include&&x.quantity>0);
}
function updateSupplierOrderTotals(){
  const rows=window._supplierOrderable||[];
  let grand=0;
  rows.forEach((x,i)=>{
    const include=document.getElementById('poInclude-'+i)?.checked!==false;
    const needed=Math.max(0,Number(x.qty_needed||0));
    const floor=Math.max(0,Number(document.getElementById('poFloor-'+i)?.value||0));
    const qty=needed+floor;
    const cost=Number(x.supply_price||0);
    const line=include?qty*cost:0;
    const qtyEl=document.getElementById('poQty-'+i);
    const totalEl=document.getElementById('poTotal-'+i);
    if(qtyEl)qtyEl.textContent=include?qty:'—';
    if(totalEl)totalEl.textContent=include&&cost?'$'+line.toFixed(2):'—';
    grand+=line;
  });
  const el=document.getElementById('supplierOrderGrandTotal');
  if(el)el.textContent='Estimated total: $'+grand.toFixed(2);
}
async function createSupplierOrderDraft(){
  const supplierId=document.getElementById('supplierSelect').value;
  if(!supplierId)return showNotice('Choose a supplier first.');
  const items=supplierOrderDraftLines();
  if(!items.length)return showNotice('Select at least one item for the supplier order.');
  const payload={
    supplier_id:supplierId,
    supplier_order_number:document.getElementById('supplierOrderNumber')?.value.trim()||null,
    notes:document.getElementById('supplierOrderNotes')?.value.trim()||null,
    created_by:'SPECIAL_ORDERS_UI',items
  };
  if(!confirm('Save this as a local draft supplier order? Nothing will be sent to Lightspeed.'))return;
  try{
    const created=await getJson(api+'/supplier-orders',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    const id=created.order?.id;
    const detail=id?await getJson(api+'/supplier-orders/'+encodeURIComponent(id)):null;
    const result=document.getElementById('supplierOrderDraftResult');
    if(result){
      const count=(detail?.items||[]).length;
      result.innerHTML='<div class="notice" style="display:block;background:var(--green-soft);color:var(--green);border-color:#bbdfc6"><b>Draft supplier order #'+(id||'—')+' saved.</b> '+count+' line'+(count===1?'':'s')+'. Local only; nothing was sent to Lightspeed.</div>';
    }
    showNotice('Draft supplier order saved.',2200);
  }catch(e){showNotice('Could not save supplier order: '+e.message)}
}
async function searchCustomers(){const q=document.getElementById('customerSearch').value.trim();if(!q)return;try{const r=await getJson(api+'/customers/search?q='+encodeURIComponent(q));document.getElementById('customerResults').innerHTML=!r.length?'<p>No Lightspeed customer found.</p>':'<table><tr><th>Name</th><th>Phone</th><th>Discord</th><th>Email</th><th></th></tr>'+r.map((x,i)=>`<tr><td>${[x.first_name,x.last_name].filter(Boolean).join(' ')||x.company_name||'Unnamed'}</td><td>${x.special_orders_phone||x.mobile||x.phone||'—'}</td><td>${x.discord_handle||'—'}</td><td>${x.email||'—'}</td><td><button onclick="chooseCustomer(${i})">Use</button></td></tr>`).join('')+'</table>';window._customerResults=r}catch(e){showNotice(e.message)}}
async function chooseCustomer(i){
  selectedCustomer=window._customerResults[i];
  showSelectedCustomer();
  document.getElementById('customerProfile').style.display='block';
  document.getElementById('customerResults').innerHTML='';
  await hydrateCustomerFields();
  saveDrafts();
}
async function hydrateCustomerFields(){
  if(!selectedCustomer)return;
  let merged={...selectedCustomer};
  try{
    const local=await getJson(api+'/customers/'+encodeURIComponent(selectedCustomer.id)+'/profile');
    if(local)merged={...merged,...local};
  }catch{}
  selectedCustomer={...selectedCustomer,...merged};

  document.getElementById('customerFirstName').value=selectedCustomer.first_name||'';
  document.getElementById('customerLastName').value=selectedCustomer.last_name||'';
  document.getElementById('customerCompany').value=selectedCustomer.company_name||'';
  document.getElementById('customerPhone').value=selectedCustomer.special_orders_phone||selectedCustomer.phone||selectedCustomer.mobile||'';
  document.getElementById('customerEmail').value=selectedCustomer.email||'';
  document.getElementById('customerDiscord').value=selectedCustomer.discord_handle||'';
  document.getElementById('customerNotes').value=selectedCustomer.special_orders_notes||selectedCustomer.notes||'';
  document.getElementById('customerAddress1').value=selectedCustomer.physical_address_1||'';
  document.getElementById('customerAddress2').value=selectedCustomer.physical_address_2||'';
  document.getElementById('customerCity').value=selectedCustomer.physical_city||'';
  document.getElementById('customerState').value=selectedCustomer.physical_state||'';
  document.getElementById('customerPostcode').value=selectedCustomer.physical_postcode||'';
  document.getElementById('customerCountry').value=selectedCustomer.physical_country_id||'US';
  document.getElementById('syncCustomerLightspeed').checked=false;
  renderCustomerSummary();
}
function renderCustomerSummary(){
  if(!selectedCustomer)return;
  const name=[selectedCustomer.first_name,selectedCustomer.last_name].filter(Boolean).join(' ')||selectedCustomer.company_name||selectedCustomer.name||'Selected customer';
  const phone=document.getElementById('customerPhone')?.value||selectedCustomer.special_orders_phone||selectedCustomer.phone||selectedCustomer.mobile||'';
  const email=document.getElementById('customerEmail')?.value||selectedCustomer.email||'';
  const discord=document.getElementById('customerDiscord')?.value||selectedCustomer.discord_handle||'';
  document.getElementById('customerSummary').textContent=[name,phone,email,discord?('Discord: '+discord):''].filter(Boolean).join(' • ');
}
const zipLookupCache=new Map();
let customerZipLookupTimer=null;
async function lookupUsZip(zip){
  const clean=String(zip||'').replace(/\D/g,'').slice(0,5);
  if(clean.length!==5)return null;
  if(zipLookupCache.has(clean))return zipLookupCache.get(clean);
  const r=await fetch('https://api.zippopotam.us/us/'+encodeURIComponent(clean));
  if(!r.ok)return null;
  const data=await r.json();
  const place=Array.isArray(data.places)?data.places[0]:null;
  const result=place?{city:place['place name']||'',state:place['state abbreviation']||place.state||''}:null;
  zipLookupCache.set(clean,result);
  return result;
}
function lookupCustomerZip(value){
  const clean=String(value||'').replace(/\D/g,'').slice(0,5);
  const status=document.getElementById('customerZipStatus');
  if(customerZipLookupTimer)clearTimeout(customerZipLookupTimer);
  if(clean.length!==5){if(status)status.textContent='';return}
  if(status)status.textContent='Looking up ZIP…';
  customerZipLookupTimer=setTimeout(async()=>{
    try{
      const place=await lookupUsZip(clean);
      if(!place){if(status)status.textContent='ZIP not found';return}
      document.getElementById('customerCity').value=place.city;
      document.getElementById('customerState').value=place.state;
      if(status)status.textContent=place.city+', '+place.state;
      saveDrafts();
    }catch(e){
      if(status)status.textContent='ZIP lookup unavailable';
    }
  },200);
}
async function verifyCustomerAddress(){
  const street=document.getElementById('customerAddress1').value.trim();
  const secondary=document.getElementById('customerAddress2').value.trim();
  const city=document.getElementById('customerCity').value.trim();
  const state=document.getElementById('customerState').value.trim();
  const zip=document.getElementById('customerPostcode').value.trim();
  const box=document.getElementById('customerAddressVerify');
  if(!street)return showNotice('Enter the street address before verifying it.');
  box.style.display='block';
  box.innerHTML='Checking address with USPS…';
  try{
    const r=await getJson(api+'/address/verify-usps',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({street_address:street,secondary_address:secondary,city,state,zip})
    });
    const zipText=r.zip_plus4?r.zip+'-'+r.zip_plus4:r.zip;
    const display=[r.street_address,r.secondary_address,[r.city,r.state,zipText].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    box.innerHTML='<b>USPS standardized address:</b> '+display+
      '<div style="margin-top:8px"><button type="button" id="acceptUspsAddress">Use USPS address</button></div>';
    document.getElementById('acceptUspsAddress').onclick=()=>{
      writeField('customerPostcode',zipText||'');
      writeField('customerAddress1',r.street_address||'');
      writeField('customerAddress2',r.secondary_address||'');
      writeField('customerCity',r.city||'');
      writeField('customerState',r.state||'');
      box.innerHTML='<b>USPS address accepted.</b> '+display;
      saveDrafts();
    };
  }catch(e){
    box.innerHTML='<b>Could not verify address.</b> '+e.message;
  }
}
function openCustomerModal(){
  if(!selectedCustomer)return showNotice('Select a customer first.');
  hydrateCustomerFields();
  document.getElementById('customerModal').style.display='flex';
}
function closeCustomerModal(){document.getElementById('customerModal').style.display='none'}
async function updateCustomerProfile(){
  if(!selectedCustomer)return showNotice('Select a customer first.');
  const first=document.getElementById('customerFirstName').value.trim();
  const last=document.getElementById('customerLastName').value.trim();
  const company=document.getElementById('customerCompany').value.trim();
  const payload={
    name:[first,last].filter(Boolean).join(' ')||company||selectedCustomer.name||'Unnamed',
    first_name:first||null,
    last_name:last||null,
    company_name:company||null,
    email:document.getElementById('customerEmail').value.trim()||null,
    phone:document.getElementById('customerPhone').value.trim()||null,
    mobile:document.getElementById('customerPhone').value.trim()||null,
    discord_handle:document.getElementById('customerDiscord').value.trim()||null,
    notes:document.getElementById('customerNotes').value.trim()||null,
    address_line_1:document.getElementById('customerAddress1').value.trim()||null,
    address_line_2:document.getElementById('customerAddress2').value.trim()||null,
    city:document.getElementById('customerCity').value.trim()||null,
    state:document.getElementById('customerState').value.trim()||null,
    postcode:document.getElementById('customerPostcode').value.trim()||null,
    country_code:document.getElementById('customerCountry').value.trim()||null,
    sync_lightspeed:document.getElementById('syncCustomerLightspeed').checked
  };
  try{
    const r=await getJson(api+'/customers/'+encodeURIComponent(selectedCustomer.id)+'/profile',{
      method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)
    });
    selectedCustomer={
      ...selectedCustomer,
      first_name:first||null,
      last_name:last||null,
      company_name:company||null,
      email:payload.email,
      phone:payload.phone,
      mobile:payload.mobile,
      special_orders_phone:payload.phone,
      discord_handle:payload.discord_handle,
      special_orders_notes:payload.notes,
      physical_address_1:payload.address_line_1,
      physical_address_2:payload.address_line_2,
      physical_city:payload.city,
      physical_state:payload.state,
      physical_postcode:payload.postcode,
      physical_country_id:payload.country_code
    };
    showSelectedCustomer();
    renderCustomerSummary();
    closeCustomerModal();
    if(r.lightspeed_warning)showNotice('Customer saved locally, but Lightspeed update warning: '+r.lightspeed_warning);
    else showNotice(payload.sync_lightspeed?'Customer updated here and in Lightspeed.':'Customer updated for Special Orders.',2200);
    saveDrafts();
  }catch(e){showNotice('Customer update failed: '+e.message)}
}
function detectProductCodeType(value){
  const raw=String(value||'').trim();
  const compact=raw.replace(/[\s-]/g,'');
  const digits=onlyDigits(raw);
  if(!raw)return {type:null,code:'',label:'Type will be detected automatically'};
  if(/^\d{9}[\dXx]$/.test(compact))return {type:'ISBN',code:compact.toUpperCase(),label:'Detected ISBN-10'};
  if(/^\d{13}$/.test(compact) && (compact.startsWith('978')||compact.startsWith('979')))return {type:'ISBN',code:compact,label:'Detected ISBN-13'};
  if(/^\d{12}$/.test(compact))return {type:'UPC',code:compact,label:'Detected UPC'};
  if(/^\d{8}$/.test(compact) || /^\d{13}$/.test(compact))return {type:'EAN',code:compact,label:'Detected EAN'};
  if(digits===compact && digits.length>=11 && digits.length<=18)return {type:'UPC',code:compact,label:'Detected numeric product code (stored as UPC)'};
  return {type:'CUSTOM',code:raw,label:'Custom product code'};
}
function updateDetectedProductCode(){
  const field=document.getElementById('cpProductCode');
  const label=document.getElementById('cpProductCodeType');
  if(!field||!label)return;
  label.textContent=detectProductCodeType(field.value).label;
}
async function findProductMatches(queries){
  const unique=[...new Set((queries||[]).map(x=>String(x||'').trim()).filter(Boolean))];
  const found=[];
  const seen=new Set();
  const add=(row,q,exact=false)=>{
    if(!row)return;
    const key=String(row.lightspeed_product_id||row.id||row.local_id||row.sku||row.upc||row.name);
    if(seen.has(key))return;
    seen.add(key);
    found.push({...row,_match_query:q,_exact:Boolean(exact)});
  };
  for(const q of unique){
    const encoded=encodeURIComponent(q);
    const calls=await Promise.allSettled([
      getJson(api+'/products/exact?q='+encoded),
      getJson(api+'/products/search?q='+encoded),
      getJson(api+'/products/potential-matches?q='+encoded)
    ]);
    const exact=calls[0].status==='fulfilled'?calls[0].value:null;
    add(exact,q,true);
    const searchRows=calls[1].status==='fulfilled'&&Array.isArray(calls[1].value)?calls[1].value:[];
    searchRows.forEach(row=>add(row,q,false));
    const fuzzyRows=calls[2].status==='fulfilled'&&Array.isArray(calls[2].value)?calls[2].value:[];
    fuzzyRows.forEach(row=>add(row,q,false));
  }
  return found.slice(0,25);
}
function renderProductMatchRows(rows,{allowCreateAnyway=false}={}){
  const extra=allowCreateAnyway
    ? '<div class="toolbar" style="margin-top:12px"><button type="button" onclick="confirmCreateNewProduct()">Create new item anyway</button><button type="button" class="secondary-button" onclick="closeProductMatchModal()">Back to form</button></div>'
    : '';
  if(!rows.length)return '<p><b>No matching products found.</b></p>'+extra;
  return '<table><tr><th>Name</th><th>SKU</th><th>UPC / code</th><th>Source</th><th>Match</th><th></th></tr>'+
    rows.map((x,i)=>`<tr>
      <td>${x.name||'—'}</td>
      <td>${x.sku||'—'}</td>
      <td>${x.upc||'—'}</td>
      <td>${x.source||'—'}</td>
      <td>${x._exact?'Exact: ':''}${x._match_query||'—'}</td>
      <td><button type="button" onclick="chooseOrderProduct(${i},{closeModal:true})">Use existing product</button></td>
    </tr>`).join('')+'</table>'+extra;
}

async function openProductMatchModal(initialQuery){
  const modal=document.getElementById('productMatchModal');
  const q=String(initialQuery||'').trim();
  document.getElementById('productMatchSearch').value=q;
  document.getElementById('productMatchHint').textContent=editingStagedIndex!=null
    ? 'Choose the product this staged item should be linked to. Exact identifiers are matched automatically.'
    : 'Choose an existing product or create a new one if no match exists.';
  modal.style.display='flex';
  if(q)await runProductMatchSearch();
}
function closeProductMatchModal(){
  document.getElementById('productMatchModal').style.display='none';
}
function onlyDigits(value){
  return String(value||'').split('').filter(ch=>ch>='0'&&ch<='9').join('');
}
function looksLikeCode(value){
  const s=String(value||'');
  if(!s || s.includes(' '))return false;
  return s.split('').every(ch=>'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-'.includes(ch));
}
async function runProductMatchSearch(){
  const q=document.getElementById('productMatchSearch').value.trim();
  const box=document.getElementById('productMatchResults');
  if(!q){box.innerHTML='<p>Enter an identifier or product name.</p>';return}
  box.innerHTML='<p>Searching products…</p>';
  const rows=await findProductMatches([q]);
  window._orderProductResults=rows;
  if(rows.length===1 && rows[0]._exact){
    await chooseOrderProduct(0,{closeModal:true,exact:true});
    return;
  }
  box.innerHTML=renderProductMatchRows(rows);
}
async function searchOrderProducts(){
  const q=document.getElementById('newProductSearch').value.trim();
  if(!q)return;
  await openProductMatchModal(q);
}
async function chooseOrderProduct(i,options){
  options=options||{};
  const matched=window._orderProductResults&&window._orderProductResults[i];
  if(!matched)return;
  selectedOrderProduct=matched;
  if(editingStagedIndex!=null){
    const existing=stagedItems[editingStagedIndex];
    document.getElementById('manualItemName').value=matched.name||existing.requested_name||'';
    document.getElementById('manualSku').value=matched.sku||existing.requested_sku||'';
    document.getElementById('selectedProduct').textContent=(matched.name||'Product')+(matched.sku?' — '+matched.sku:'');
    await rankSuppliersForProduct(matched,existing.preferred_supplier_id,existing.supplier_ids||[]);
    const preferredSupplierId=document.getElementById('newSupplier').value||existing.preferred_supplier_id||null;
    const preferredSupplier=allSuppliers.find(s=>String(s.id)===String(preferredSupplierId));
    stagedItems[editingStagedIndex]={
      ...existing,
      product_id:matched.local_id||matched.local?.id||null,
      lightspeed_product_id:matched.lightspeed_product_id||matched.id||null,
      requested_name:matched.name||existing.requested_name,
      requested_sku:matched.sku||existing.requested_sku||null,
      preferred_supplier_id:preferredSupplierId,
      preferred_supplier_name:preferredSupplierId?(preferredSupplier?.name||existing.preferred_supplier_name||null):null,
      supplier_ids:Array.from(document.getElementById('newSuppliers').selectedOptions).map(o=>o.value),
      placeholder_product:false,
      needs_details:false,
      quick_add:false
    };
    renderStagedItems();
    saveDrafts();
    if(options.closeModal)closeProductMatchModal();
    showNotice((options.exact?'Exact identifier matched: ':'Item matched to ')+(matched.name||matched.sku||'existing product')+'.',2200);
    document.getElementById('itemEditor').scrollIntoView({behavior:'smooth',block:'center'});
    return;
  }
  document.getElementById('manualItemName').value=matched.name||'';
  document.getElementById('manualSku').value=matched.sku||'';
  document.getElementById('orderQty').value='1';
  document.getElementById('newStatus').value='OOS';
  await rankSuppliersForProduct(matched);
  if(options.closeModal)closeProductMatchModal();
}
function createProductFromMatchSearch(){
  const q=String(document.getElementById('productMatchSearch').value||document.getElementById('newProductSearch').value||'').trim();
  const staged=editingStagedIndex!=null?stagedItems[editingStagedIndex]:null;
  const existingName=cleanStagedName(staged?.requested_name||document.getElementById('manualItemName').value||'');
  const existingSku=String(staged?.requested_sku||document.getElementById('manualSku').value||'').trim();
  const digits=onlyDigits(q);
  closeProductMatchModal();
  showCreateProduct();
  if(existingName)writeField('cpName',existingName);
  else if(!looksLikeCode(q) && q)writeField('cpName',q);
  if(existingSku)writeField('cpSku',existingSku);
  else if(looksLikeCode(q) && q)writeField('cpSku',q);
  if([8,10,12,13,14].includes(digits.length))writeField('cpProductCode',digits);
  updateDetectedProductCode();
  if(staged?.source_url)writeField('cpSourceUrl',staged.source_url);
  if(staged?.notes && !document.getElementById('cpDescription').value)writeField('cpDescription',staged.notes);
  saveDrafts();
  document.getElementById('createProductPanel').scrollIntoView({behavior:'smooth',block:'start'});
  showNotice('New item form opened with the search information filled in. Complete the required product details.',2600);
}
async function createOrder(){
  if(!selectedCustomer)return showNotice('Select a Lightspeed customer first.');
  if(!stagedItems.length)return showNotice('Add at least one item to this order first.');
  const customerName=[selectedCustomer.first_name,selectedCustomer.last_name].filter(Boolean).join(' ')||selectedCustomer.company_name||selectedCustomer.name||'Unnamed';
  const payload={
    customer:{
      lightspeed_customer_id:selectedCustomer.id,
      name:customerName,
      phone:document.getElementById('customerPhone').value.trim()||selectedCustomer.mobile||selectedCustomer.phone||null,
      email:document.getElementById('customerEmail').value.trim()||selectedCustomer.email||null,
      discord_handle:document.getElementById('customerDiscord').value.trim()||null,
      notes:document.getElementById('customerNotes').value.trim()||null
    },
    notes:document.getElementById('orderNotes').value.trim()||null,
    items:stagedItems
  };
  try{
    await getJson(api+'/orders',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    showNotice('Special order saved with '+stagedItems.length+' item'+(stagedItems.length===1?'':'s')+'.',2500);
    clearOrderForm();
    await loadStats();await loadOrders();
  }catch(e){showNotice(e.message)}
}
async function searchProducts(){const q=document.getElementById('productSearch').value.trim();if(!q)return;try{const r=await getJson(api+'/products/search?q='+encodeURIComponent(q));document.getElementById('productResults').innerHTML='<h3>Product matches</h3>'+(!r.length?'<p>No match found. Product creation will be the next form added here.</p>':'<table><tr><th>Name</th><th>SKU</th><th>UPC</th><th>Source</th></tr>'+r.map(x=>`<tr><td>${x.name}</td><td>${x.sku||'—'}</td><td>${x.upc||'—'}</td><td>${x.source}</td></tr>`).join('')+'</table>')}catch(e){showNotice(e.message)}}
let allProductCategories=[];
function categoryChildren(parentId){
  return allProductCategories
    .filter(x=>(x.parent_id||null)===(parentId||null))
    .sort((a,b)=>String(a.name).localeCompare(String(b.name)));
}
function setSelectedCategory(id){
  const row=allProductCategories.find(x=>String(x.id)===String(id));
  if(!row)return;
  document.getElementById('cpCategory').value=row.id;
  document.getElementById('categoryBreadcrumb').textContent=row.path||row.name;
  document.getElementById('cpCategorySearch').value='';
  document.getElementById('categoryMatches').innerHTML='';
  renderCategoryLevels(row.id);
  saveDrafts();
}
function renderCategoryLevels(selectedId=null){
  const holder=document.getElementById('categoryLevels');
  holder.innerHTML='';
  if(!allProductCategories.length)return;

  const selected=selectedId?allProductCategories.find(x=>String(x.id)===String(selectedId)):null;
  const chain=[];
  let cur=selected;
  const guard=new Set();
  while(cur && !guard.has(String(cur.id))){
    chain.unshift(cur);
    guard.add(String(cur.id));
    cur=cur.parent_id?allProductCategories.find(x=>String(x.id)===String(cur.parent_id)):null;
  }

  let parentId=null;
  let depth=0;
  while(depth<8){
    const children=categoryChildren(parentId);
    if(!children.length)break;
    const select=document.createElement('select');
    select.innerHTML='<option value="">'+(depth===0?'Choose category…':'Choose subcategory…')+'</option>'+
      children.map(x=>`<option value="${x.id}">${x.name}</option>`).join('');
    const chosen=chain[depth];
    if(chosen)select.value=chosen.id;
    select.onchange=()=>{
      const id=select.value;
      if(!id){
        document.getElementById('cpCategory').value='';
        document.getElementById('categoryBreadcrumb').textContent='No category selected';
        renderCategoryLevels(null);
        return;
      }
      setSelectedCategory(id);
    };
    holder.appendChild(select);
    if(!chosen)break;
    parentId=chosen.id;
    depth++;
    if(!categoryChildren(parentId).length)break;
  }
}
function filterCategoryMatches(){
  const q=document.getElementById('cpCategorySearch').value.trim().toLowerCase();
  const box=document.getElementById('categoryMatches');
  if(!q){box.innerHTML='';return}
  const matches=allProductCategories
    .filter(x=>(x.path||x.name||'').toLowerCase().includes(q))
    .slice(0,30);
  box.innerHTML=!matches.length
    ? '<div style="color:#64748b">No category matches.</div>'
    : '<div style="display:flex;gap:6px;flex-wrap:wrap">'+matches.map(x=>`<button type="button" onclick="setSelectedCategory('${String(x.id).replace(/'/g,"\\'")}')">${x.path||x.name}</button>`).join('')+'</div>';
}
async function loadProductCategories(){
  try{
    const c=await getJson(api+'/product-categories');
    allProductCategories=Array.isArray(c)?c:[];
    if(!allProductCategories.length){
      document.getElementById('categoryBreadcrumb').textContent='No Lightspeed categories returned';
      document.getElementById('categoryLevels').innerHTML='';
      return;
    }
    renderCategoryLevels(document.getElementById('cpCategory').value||null);
  }catch(e){
    document.getElementById('categoryBreadcrumb').textContent='Category load failed';
    document.getElementById('categoryLevels').innerHTML='';
    showNotice('Could not load Lightspeed categories: '+e.message);
  }
}
let pendingCreateProductPayload=null;
async function createLightspeedProduct(){
  const payload=buildCreateProductPayload();
  if(!payload)return;

  pendingCreateProductPayload=payload;
  const result=document.getElementById('createProductResult');
  result.innerHTML='<p>Checking for existing product matches…</p>'+
    '<div class="toolbar"><button type="button" onclick="confirmCreateNewProduct()">Create without waiting</button></div>';

  const queries=[
    payload.product_code?.code,
    payload.sku,
    payload.supplier_sku,
    payload.name
  ].filter(Boolean);

  let matches=[];
  let timedOut=false;
  try{
    const outcome=await Promise.race([
      findProductMatches(queries).then(rows=>({rows})),
      new Promise(resolve=>setTimeout(()=>resolve({rows:[],timeout:true}),4500))
    ]);
    matches=outcome.rows||[];
    timedOut=Boolean(outcome.timeout);
  }catch(e){
    console.warn('Pre-create product match check failed',e);
  }

  if(matches.length){
    window._orderProductResults=matches;
    document.getElementById('productMatchHint').textContent=
      'These existing products may match the new item. Choose one, or create the new product anyway without losing your form.';
    document.getElementById('productMatchSearch').value=payload.product_code?.code||payload.sku||payload.name;
    document.getElementById('productMatchResults').innerHTML=renderProductMatchRows(matches,{allowCreateAnyway:true});
    document.getElementById('productMatchModal').style.display='flex';
    result.innerHTML='';
    return;
  }

  if(timedOut){
    result.innerHTML='<p>Match check is taking longer than expected. You can create the item now or search again.</p>'+
      '<div class="toolbar"><button type="button" onclick="confirmCreateNewProduct()">Create new item</button>'+
      '<button type="button" class="secondary-button" onclick="retryCreateProductMatchCheck()">Check matches again</button></div>';
    return;
  }

  result.innerHTML='<p>No likely existing product matches were found.</p>'+
    '<div class="toolbar"><button type="button" onclick="confirmCreateNewProduct()">Create new item</button>'+
    '<button type="button" class="secondary-button" onclick="retryCreateProductMatchCheck()">Check matches again</button></div>';
}
async function retryCreateProductMatchCheck(){
  await createLightspeedProduct();
}
function buildCreateProductPayload(){
  const name=document.getElementById('cpName').value.trim();
  const sku=document.getElementById('cpSku').value.trim();
  const cost=document.getElementById('cpCost').value;
  const retail=document.getElementById('cpRetail').value;
  const category=document.getElementById('cpCategory').value;
  if(!name||!sku||cost===''||retail===''||!category){
    showNotice('Name, SKU, cost, retail price, and category are required.');
    return null;
  }
  const productCode=detectProductCodeType(document.getElementById('cpProductCode').value);
  const payload={
    name,sku,supply_price:Number(cost),price_including_tax:Number(retail),product_category_id:category,
    description:document.getElementById('cpDescription').value.trim()||null,
    image_url:document.getElementById('cpImageUrl').value.trim()||null,
    source_url:document.getElementById('cpSourceUrl').value.trim()||null,
    local_supplier_id:document.getElementById('cpSupplier').value||null,
    supplier_sku:document.getElementById('cpSupplierSku').value.trim()||null,
    order_channel:document.getElementById('cpOrderChannel').value
  };
  if(productCode.code){
    payload.product_code=productCode;
    payload.product_codes=[{type:productCode.type,code:productCode.code}];
    if(productCode.type==='ISBN')payload.isbn=productCode.code;
  }
  return payload;
}
async function confirmCreateNewProduct(){
  const payload=pendingCreateProductPayload||buildCreateProductPayload();
  if(!payload)return;
  if(!confirm('Create this product in the connected Lightspeed account? This is a real test write.'))return;
  closeProductMatchModal();
  try{
    const r=await getJson(api+'/products/create-lightspeed',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    const p=r.lightspeed||{};
    selectedOrderProduct={
      id:p.id||null,lightspeed_product_id:p.id||null,local_id:r.local?.id||null,
      name:p.name||payload.name,sku:p.sku||payload.sku,
      upc:payload.product_code?.code||null,source:'lightspeed'
    };
    document.getElementById('manualItemName').value=selectedOrderProduct.name||'';
    document.getElementById('manualSku').value=selectedOrderProduct.sku||'';
    document.getElementById('selectedProduct').textContent=(selectedOrderProduct.name||'Product')+(selectedOrderProduct.sku?' — '+selectedOrderProduct.sku:'');
    document.getElementById('createProductResult').innerHTML=`<p><b>Created.</b> Lightspeed UUID: <code>${p.id||'—'}</code> &nbsp; SKU: <b>${p.sku||payload.sku}</b> &nbsp; Tag: <b>${r.tag||'Added by SO'}</b></p>`+
      (r.image_warning?`<p class="danger">Product created, but image warning: ${r.image_warning}</p>`:'');
    pendingCreateProductPayload=null;
    hideCreateProduct();
    document.getElementById('itemEditor').style.display='block';
    clearProductForm();
    saveDrafts();
    showNotice('New Lightspeed item created. Review the quantity/status, then click Add item to order.',3500);
  }catch(e){showNotice('Product creation failed: '+e.message)}
}
async function loadPreorders(){try{const c=await getJson(api+'/preorders/campaigns');document.getElementById('preorderCampaign').innerHTML='<option value="">Select preorder campaign…</option>'+c.map(x=>`<option value="${x.id}">${x.name} — ${x.request_count} requests</option>`).join('')}catch(e){}}
async function loadPreorderCampaign(){
  const id=document.getElementById('preorderCampaign').value;
  document.getElementById('allocationSuggestions').innerHTML='';
  if(!id){document.getElementById('preorderProducts').innerHTML='';return}
  try{
    const d=await getJson(api+'/preorders/campaigns/'+id);
    document.getElementById('preorderProducts').innerHTML='<table><tr><th>Product</th><th>Ordered</th><th>Received</th><th>Requested</th><th>Allocated</th><th>Available</th><th></th></tr>'+
      d.products.map(x=>{
        const available=Math.max(0,Number(x.received_quantity||0)-Number(x.reserved_floor_quantity||0)-Number(x.allocated_total||0));
        return `<tr><td>${x.item_description}</td><td>${x.ordered_quantity}</td><td>${x.received_quantity}</td><td>${x.requested_total}</td><td>${x.allocated_total}</td><td>${available}</td><td><button onclick="showAllocationSuggestions(${x.id},${available})">Suggested</button> <button onclick="allocatePreorder(${x.id},'FAIR_SHARE')">Fair share</button> <button onclick="allocatePreorder(${x.id},'QUEUE')">Queue</button></td></tr>`
      }).join('')+'</table>';
  }catch(e){showNotice(e.message)}
}
async function showAllocationSuggestions(id,available){
  const box=document.getElementById('allocationSuggestions');
  box.innerHTML='<p>Calculating suggested allocation…</p>';
  try{
    const d=await getJson(api+'/preorders/products/'+id+'/allocation-suggestions?available_quantity='+encodeURIComponent(available)+'&refresh_lightspeed=1');
    const rows=d.suggestions||[];
    box.innerHTML='<h3>Suggested allocation <span class="pill">Advisory only</span></h3>'+
      '<p style="color:#64748b">Higher scores reward reliable pickup history and purchase history. Nothing is allocated until you choose an allocation action.</p>'+
      (!rows.length?'<p>No unallocated requests for this product.</p>':
      '<table><tr><th>Rank</th><th>Customer</th><th>Score</th><th>Suggested Qty</th><th>History</th><th>Purchase History</th><th>Flags</th></tr>'+
      rows.map((x,i)=>`<tr>
        <td>${i+1}</td>
        <td>${x.customer_name||x.discord_handle||'Customer'}</td>
        <td><b>${x.allocation_score}</b></td>
        <td>${x.suggested_quantity}</td>
        <td>${x.picked_up||0} picked up · ${x.late_pickups||0} late · ${x.no_pickups||0} missed</td>
        <td>${x.sources?((x.purchase_count||0)+' purchases · $'+Number(x.gross_spend||0).toFixed(2)+' · '+x.sources):'Not synced yet'}</td>
        <td>${(x.flags||[]).join('; ')||'—'}</td>
      </tr>`).join('')+'</table>');
  }catch(e){
    box.innerHTML='';
    showNotice('Could not build allocation suggestions: '+e.message);
  }
}

async function allocatePreorder(id,method){if(!confirm('Allocate currently available preorder inventory using '+method+'?'))return;try{const d=await getJson(api+'/preorders/products/'+id+'/allocate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method})});showNotice(`Allocated ${d.newlyAllocated}; ${d.remaining} still available.`);await loadPreorderCampaign()}catch(e){showNotice(e.message)}}
async function loadAll(){await Promise.allSettled([loadStats(),loadOrders(),loadSuppliers(),loadDepartments(),loadProductCategories(),loadPreorders()])}
document.addEventListener('input',e=>{if(orderDraftIds.includes(e.target.id)||productDraftIds.includes(e.target.id))saveDrafts()});
document.addEventListener('change',e=>{if(orderDraftIds.includes(e.target.id)||productDraftIds.includes(e.target.id)||e.target.id==='newSuppliers')saveDrafts()});
document.getElementById('accessKey').value=accessKey();
setAuthState(false);
if(accessKey()){
  saveKey();
}else{
  showNotice('Special Orders is locked. Enter the internal access key above and click Unlock.');
}
