// Purchase Order Companion — read-only UI foundation.
// Runs only when explicitly injected by the toolbar popup into the active tab.
(async () => {
  const ID = 'hc-po-companion-host';
  const existing = document.getElementById(ID);
  if (existing) { existing.remove(); return; }
  const host = document.createElement('div');
  host.id = ID;
  host.style.cssText = 'position:fixed;right:0;top:0;bottom:0;z-index:2147483646;';
  const shadow = host.attachShadow({mode:'closed'});
  const style = document.createElement('style');
  style.textContent = `
    *{box-sizing:border-box} :host{font:13px system-ui,Arial,sans-serif;color:#17212b}
    .wrap{height:100vh;width:min(440px,27vw);min-width:300px;resize:horizontal;overflow:hidden;
      display:flex;flex-direction:column;background:#fff;border-left:2px solid #153d53;
      box-shadow:-5px 0 18px #0003}
    header{background:#153d53;color:white;padding:10px;display:flex;justify-content:space-between;align-items:center}
    h2{font-size:15px;margin:0}button{cursor:pointer;border:1px solid #b6c7d0;border-radius:5px;padding:5px 8px;background:#f5f8fb;color:#102e42}
    header button{background:#fff}.body{padding:10px;overflow:auto;flex:1}
    .muted{color:#687987;font-size:12px}.notice{background:#fff8e1;padding:8px;border-radius:5px}
    .toolbar{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:8px 0}
    .item{border-bottom:1px solid #d7e0e6;padding:10px 0}.line{display:flex;align-items:center;gap:5px}
    .name{margin:3px 0 3px 23px;font-weight:600;overflow-wrap:anywhere}
    .code{font-family:ui-monospace,monospace;overflow-wrap:anywhere;flex:1}
    .fields{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:8px 0 0 22px}
    [hidden]{display:none!important}.fields label{font-size:11px;color:#344f61}.fields input{display:block;width:100%;padding:5px}
    .warning{color:#9b4e08}.error{color:#a51d27}.good{color:#17633d}
    footer{padding:8px;border-top:1px solid #d7e0e6;display:flex;justify-content:space-between}
    .collapsed{width:38px;min-width:38px;resize:none}.collapsed .body,.collapsed footer,.collapsed h2{display:none}
    .collapsed header{height:100%;align-items:flex-start;justify-content:center}
  `;
  const shell = document.createElement('div'); shell.className='wrap';
  const header=document.createElement('header'), title=document.createElement('h2'); title.textContent='PO Companion';
  const collapse=document.createElement('button');collapse.textContent='−';collapse.title='Collapse or expand';
  collapse.onclick=()=>{const yes=shell.classList.toggle('collapsed');collapse.textContent=yes?'+':'−';};
  const close=document.createElement('button');close.textContent='×';close.title='Close';
  close.onclick=()=>host.remove();header.append(title,collapse,close);
  const body=document.createElement('div');body.className='body';
  const description=document.createElement('p');description.className='muted';
  const toolbar=document.createElement('div');toolbar.className='toolbar';
  const mode=document.createElement('select');mode.setAttribute('aria-label','Identifier to copy');
  [['supplierSku','Supplier SKU'],['upc','UPC']].forEach(([v,label])=>{const option=document.createElement('option');option.value=v;option.textContent=label;mode.append(option);});
  const count=document.createElement('span');count.className='muted';
  toolbar.append('Copy: ',mode,count);
  const notice=document.createElement('p');notice.className='notice';
  const items=document.createElement('div');
  const footer=document.createElement('footer');const summary=document.createElement('span');const review=document.createElement('button');
  review.textContent='Review Changes';review.onclick=()=>chrome.runtime.sendMessage({type:'HCT_PO_REVIEW'});
  footer.append(summary,review);body.append(description,toolbar,notice,items);shell.append(header,body,footer);shadow.append(style,shell);document.documentElement.append(host);
  const {poCompanionContext:context,poCompanionDrafts:allDrafts={}}=await chrome.storage.local.get(['poCompanionContext','poCompanionDrafts']);
  if(!context?.poId){description.textContent='No PO selected.';notice.textContent='Open the Lightspeed purchase order and choose “Use Current PO” from the Hobby Corner extension first.';review.disabled=true;return;}
  description.textContent='PO '+context.poId+' • Sign in to load items.';
  notice.textContent='Read-only test build. No PO or product changes can be submitted.';
  const login=document.createElement('div');login.className='toolbar';
  const pin=document.createElement('input');pin.type='password';pin.inputMode='numeric';pin.maxLength=4;pin.placeholder='Timeclock PIN';pin.setAttribute('aria-label','Employee Timeclock PIN');
  const signIn=document.createElement('button');signIn.textContent='Sign in & Load PO';
  const reload=document.createElement('button');reload.textContent='Reload PO';reload.hidden=true;
  const signOut=document.createElement('button');signOut.textContent='Sign out';signOut.hidden=true;
  login.append(pin,signIn,reload,signOut);body.insertBefore(login,toolbar);
  let key=null,draft=null,lines=[];
  const save=async()=>{
    if(!key||!draft)return;
    draft.updatedAt=new Date().toISOString();
    const stored=(await chrome.storage.local.get('poCompanionDrafts')).poCompanionDrafts||{};
    stored[key]=draft;await chrome.storage.local.set({poCompanionDrafts:stored});
  };
  mode.onchange=()=>{if(!draft)return;draft.identifierMode=mode.value;save();render();};
  async function loadPo(){
    const result=await chrome.runtime.sendMessage({type:'HCT_PO_LOAD',poId:String(context.poId)});
    if(!result?.ok)throw new Error(result?.error||'PO load failed.');
    const po=result.data.purchaseOrder;
    const supplierId=po.supplier?.localId;
    key=String(context.poId)+':'+String(supplierId||'unresolved');
    draft=(await chrome.storage.local.get('poCompanionDrafts')).poCompanionDrafts?.[key]||
      {poId:context.poId,supplierId:supplierId||null,identifierMode:'supplierSku',items:{}};
    mode.value=draft.identifierMode||'supplierSku';
    lines=result.data.items;description.textContent='PO '+context.poId+' • '+(po.supplier?.name||'Supplier '+supplierId);
    const warnings=lines.reduce((n,x)=>n+(x.warnings?.length?1:0),0);
    notice.textContent=(supplierId?'':'Supplier not mapped: supplier SKU is unavailable. ')+lines.length+' PO items loaded. '+warnings+' with warnings. Review only — no writes enabled.';
    await save();render();reload.hidden=false;signOut.hidden=false;signIn.hidden=true;pin.hidden=true;
  }
  signIn.onclick=async()=>{
    signIn.disabled=true;
    try{
      const p=pin.value;pin.value='';
      const result=await chrome.runtime.sendMessage({type:'HCT_PO_LOGIN',pin:p});
      if(!result?.ok)throw new Error(result?.error||'Sign-in failed.');
      await loadPo();
    }catch(error){notice.textContent=error.message;}
    finally{signIn.disabled=false;pin.value='';}
  };
  reload.onclick=async()=>{try{await loadPo()}catch(error){notice.textContent=error.message;}};
  signOut.onclick=async()=>{
    await chrome.runtime.sendMessage({type:'HCT_PO_LOGOUT'});
    lines=[];key=null;draft=null;render();signIn.hidden=false;pin.hidden=false;reload.hidden=true;signOut.hidden=true;
    description.textContent='PO '+context.poId+' • Signed out.';notice.textContent='Sign in to reload the PO.';
  };
  function render(){
    items.replaceChildren();count.textContent=lines.length+' items';
    for (const item of lines) {
      const row=document.createElement('div');row.className='item';
      const state=draft?.items?.[item.lineId]||{selected:false,proposed:{}};
      const top=document.createElement('div');top.className='line';
      const check=document.createElement('input');check.type='checkbox';check.checked=!!state.selected;
      const code=document.createElement('span');code.className='code';
      const id=state.identifierOverride||draft?.identifierMode||'supplierSku';
      const value=id==='upc'?item.upc:item.supplierSku;
      code.textContent=value||('Missing '+(id==='upc'?'UPC':'supplier SKU'));
      if(!value)code.classList.add('warning');
      const copy=document.createElement('button');copy.textContent='Copy';copy.disabled=!value;
      copy.onclick=()=>navigator.clipboard.writeText(value);
      const qty=document.createElement('strong');qty.textContent='×'+item.quantity;
      top.append(check,code,copy,qty);
      const name=document.createElement('div');name.className='name';name.textContent=item.name;
      row.append(top,name);
      const fields=document.createElement('div');fields.className='fields';fields.hidden=!check.checked;
      for (const [field,label] of [['reorderPoint','RP'],['reorderQuantity','RQ'],['supplierCost','Cost'],['msrp','MSRP']]){
        const l=document.createElement('label');l.textContent=label;
        const input=document.createElement('input');input.type='number';input.min='0';input.step=field==='reorderPoint'||field==='reorderQuantity'?'1':'0.01';
        input.value=state.proposed[field]??'';input.oninput=()=>{state.proposed[field]=input.value;draft.items[item.lineId]=state;save();};
        l.append(input);fields.append(l);
      }
      check.onchange=()=>{state.selected=check.checked;draft.items[item.lineId]=state;fields.hidden=!check.checked;save();};
      row.append(fields);
      if(item.warnings?.length){const warning=document.createElement('div');warning.className='warning';warning.textContent='⚠ '+item.warnings.join(', ').replaceAll('_',' ').toLowerCase();row.append(warning);}
      items.append(row);
    }
    summary.textContent=Object.values(draft?.items||{}).filter(x=>x.selected).length+' selected';
    review.disabled=!draft||!Object.values(draft.items).some(x=>x.selected);
  }
  render();review.disabled=true;
})();
