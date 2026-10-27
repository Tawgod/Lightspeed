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
    *{box-sizing:border-box}
    :host{font:13px system-ui,-apple-system,"Segoe UI",sans-serif;color:#21313b}
    .wrap{height:100dvh;width:min(430px,27vw);min-width:310px;resize:horizontal;overflow:auto;
      display:flex;flex-direction:column;background:#e8eef1;border-left:1px solid #8fa4af;
      box-shadow:-8px 0 26px #102d3d40}
    header{background:#183f53;color:#fff;padding:14px 13px;display:flex;gap:8px;align-items:center;
      border-bottom:3px solid #bbd7d5}
    h2{font-size:16px;line-height:1.3;font-weight:750;margin:0;flex:1}
    button,select,input{font:inherit}
    button{cursor:pointer;border:1px solid #a7bbc6;border-radius:8px;min-height:34px;
      padding:6px 10px;background:#f5f8fa;color:#183f53;font-weight:650}
    button:hover:not(:disabled){background:#dcebed}
    button:focus-visible,select:focus-visible,input:focus-visible{outline:3px solid #e1aa39;outline-offset:2px}
    button:disabled,input:disabled{opacity:.55;cursor:not-allowed}
    header button{background:#e6f0f2;min-width:34px;min-height:34px}
    .body{padding:12px;overflow:auto;flex:1}
    .muted{color:#516671;font-size:12px;line-height:1.5}
    .notice{background:#fff3d9;border-left:4px solid #b2771b;color:#563f17;padding:10px 11px;
      border-radius:7px;line-height:1.4}
    .toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:10px 0;padding:10px;
      background:#dce7ec;border:1px solid #c3d2da;border-radius:10px}
    select,.toolbar input{border:1px solid #90aab8;border-radius:7px;min-height:34px;padding:6px;background:#fff;color:#21313b}
    .toolbar input{min-width:120px;max-width:160px}
    .item{background:#f8fafb;border:1px solid #c7d5dc;border-radius:10px;padding:11px;margin:9px 0;
      box-shadow:0 1px 3px #12344612}
    .line{display:flex;align-items:center;gap:7px}
    .line input[type=checkbox]{width:17px;height:17px;accent-color:#176f77;flex-shrink:0}
    .name{margin:7px 0 5px 24px;font-weight:650;line-height:1.4;overflow-wrap:anywhere}
    .code{font-family:ui-monospace,SFMono-Regular,monospace;overflow-wrap:anywhere;flex:1;min-width:0}
    .fields{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:10px 0 0 24px;padding:11px;
      background:#e6eff3;border:1px solid #c5d5dd;border-radius:8px}
    [hidden]{display:none!important}
    .fields label{font-size:12px;color:#345161;font-weight:600}
    .fields input{display:block;width:100%;min-height:34px;margin-top:4px;padding:7px;
      border:1px solid #9bb2be;border-radius:6px;background:#fff}
    .warning{color:#87510d;background:#fff1d3;border-radius:6px;padding:6px 8px;margin-top:7px;line-height:1.4}
    .error{color:#9e2330}.good{color:#126c50}
    footer{padding:11px 12px;background:#d6e2e8;border-top:1px solid #aebfc9;
      display:flex;align-items:center;justify-content:space-between;gap:8px}
    footer button{background:#176e76;border-color:#176e76;color:#fff}
    footer button:hover:not(:disabled){background:#155b63}
    .collapsed{width:44px;min-width:44px;resize:none}
    .collapsed .body,.collapsed footer,.collapsed h2,.collapsed header img,.collapsed header button:last-child{display:none}
    .collapsed header{height:100%;align-items:flex-start;justify-content:center;padding:8px 4px}
    @media(prefers-reduced-motion:no-preference){button{transition:background .12s ease}}
  `;
  shadow.append(style);
  try { const shared=await chrome.runtime.sendMessage({type:'HCT_PO_STYLE'});if(shared?.ok && typeof shared.css==='string'){const s=document.createElement('style');s.textContent=shared.css;shadow.append(s);} } catch { /* local fallback styling remains */ }
  const shell = document.createElement('div'); shell.className='wrap hc-ui hc-panel--drawer';
  const header=document.createElement('header'), title=document.createElement('h2');header.className='hc-topbar'; title.textContent='Hobby Corner · PO Companion';
  const brand=document.createElement('img');brand.alt='';brand.width=32;brand.height=32;brand.style.cssText='width:32px;height:32px;object-fit:contain;background:white;border-radius:50%;padding:2px';
  try{const result=await chrome.runtime.sendMessage({type:'HCT_PO_BRAND'});if(result?.ok)brand.src=result.url;}catch{}
  const collapse=document.createElement('button');collapse.className='hc-button hc-button--secondary';collapse.textContent='−';collapse.title='Collapse or expand';
  collapse.onclick=()=>{const yes=shell.classList.toggle('collapsed');collapse.textContent=yes?'+':'−';};
  const close=document.createElement('button');close.className='hc-button hc-button--secondary';close.textContent='×';close.title='Close';
  close.onclick=()=>host.remove();header.append(brand,title,collapse,close);
  const body=document.createElement('div');body.className='body hc-stack';
  const description=document.createElement('p');description.className='muted';
  const toolbar=document.createElement('div');toolbar.className='toolbar hc-inset';
  const mode=document.createElement('select');mode.className='hc-select';mode.setAttribute('aria-label','Identifier to copy');
  [['supplierSku','Supplier SKU'],['upc','UPC']].forEach(([v,label])=>{const option=document.createElement('option');option.value=v;option.textContent=label;mode.append(option);});
  const count=document.createElement('span');count.className='muted';
  toolbar.append('Copy: ',mode,count);
  const notice=document.createElement('p');notice.className='notice hc-alert hc-alert--warning';notice.setAttribute('role','status');notice.setAttribute('aria-live','polite');
  const items=document.createElement('div');
  const footer=document.createElement('footer');const summary=document.createElement('span');const review=document.createElement('button');
  review.className='hc-button';review.textContent='Review Changes';review.setAttribute('aria-label','Review selected purchase order changes');review.onclick=()=>chrome.runtime.sendMessage({type:'HCT_PO_REVIEW'});
  footer.append(summary,review);body.append(description,toolbar,notice,items);shell.append(header,body,footer);shadow.append(shell);document.documentElement.append(host);
  const {poCompanionContext:context,poCompanionDrafts:allDrafts={}}=await chrome.storage.local.get(['poCompanionContext','poCompanionDrafts']);
  if(!context?.poId){description.textContent='No PO selected.';notice.textContent='Open the Lightspeed purchase order and choose “Use Current PO” from the Hobby Corner extension first.';review.disabled=true;return;}
  description.textContent='PO '+context.poId+' • Sign in to load items.';
  notice.textContent='Consolidated development preview: live PO access remains disabled pending endpoint validation. No Lightspeed changes can be submitted.';
  const login=document.createElement('div');login.className='toolbar hc-inset';
  const pin=document.createElement('input');pin.className='hc-input';pin.type='password';pin.inputMode='numeric';pin.maxLength=4;pin.placeholder='Timeclock PIN';pin.setAttribute('aria-label','Employee Timeclock PIN');
  const signIn=document.createElement('button');signIn.className='hc-button';signIn.textContent='Sign in & Load PO';
  const reload=document.createElement('button');reload.className='hc-button hc-button--secondary';reload.textContent='Reload PO';reload.hidden=true;
  const signOut=document.createElement('button');signOut.className='hc-button hc-button--secondary';signOut.textContent='Sign out';signOut.hidden=true;
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
  signIn.onclick=()=>{pin.value='';notice.textContent='Timeclock sign-in and live PO loading are disabled in this development preview. No credentials were transmitted.';};
  reload.onclick=()=>{notice.textContent='Live PO loading remains disabled until the authenticated read-only gateway is validated.';};
  signOut.onclick=async()=>{
    await chrome.runtime.sendMessage({type:'HCT_PO_LOGOUT'});
    lines=[];key=null;draft=null;render();signIn.hidden=false;pin.hidden=false;reload.hidden=true;signOut.hidden=true;
    description.textContent='PO '+context.poId+' • Signed out.';notice.textContent='Sign in to reload the PO.';
  };
  function render(){
    items.replaceChildren();count.textContent=lines.length+' items';
    for (const item of lines) {
      const row=document.createElement('div');row.className='item hc-panel';
      const state=draft?.items?.[item.lineId]||{selected:false,proposed:{}};
      const top=document.createElement('div');top.className='line';
      const check=document.createElement('input');check.type='checkbox';check.checked=!!state.selected;
      const code=document.createElement('span');code.className='code hc-mono';
      const id=state.identifierOverride||draft?.identifierMode||'supplierSku';
      const value=id==='upc'?item.upc:item.supplierSku;
      code.textContent=value||('Missing '+(id==='upc'?'UPC':'supplier SKU'));
      if(!value)code.classList.add('warning');
      const copy=document.createElement('button');copy.className='hc-button hc-button--secondary';copy.textContent='Copy';copy.disabled=!value;
      copy.onclick=async()=>{try {await navigator.clipboard.writeText(value);copy.textContent='Copied';setTimeout(()=>copy.textContent='Copy',1500);}catch{notice.textContent='Copy failed. Select the original identifier to copy manually.';}};
      const qty=document.createElement('strong');qty.textContent='×'+item.quantity;
      top.append(check,code,copy,qty);
      const name=document.createElement('div');name.className='name';name.textContent=item.name;
      row.append(top,name);
      const fields=document.createElement('div');fields.className='fields hc-inset';fields.hidden=!check.checked;
      for (const [field,label] of [['reorderPoint','RP'],['reorderQuantity','RQ'],['supplierCost','Cost'],['msrp','MSRP']]){
        const l=document.createElement('label');l.textContent=label;
        const input=document.createElement('input');input.className='hc-input';input.type='number';input.min='0';input.step=field==='reorderPoint'||field==='reorderQuantity'?'1':'0.01';
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
  render();review.disabled=true;signIn.disabled=true;pin.disabled=true;
})();
