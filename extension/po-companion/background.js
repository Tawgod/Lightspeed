// PO Companion isolated review opener. No backend mutation or employee token storage.
chrome.runtime.onMessage.addListener((message,_sender,respond)=>{
 if(message?.type==='HCT_PO_BRAND' && _sender?.tab?.id){
  fetch(chrome.runtime.getURL('shared-ui/assets/hc-icon.webp'))
    .then(r=>r.arrayBuffer())
    .then(bytes=>{const a=new Uint8Array(bytes);let binary='';for(let i=0;i<a.length;i++)binary+=String.fromCharCode(a[i]);respond({ok:true,url:'data:image/webp;base64,'+btoa(binary)});},()=>respond({ok:false}));
  return true;
 }
 if(message?.type==='HCT_PO_STYLE' && _sender?.tab?.id){
  fetch(chrome.runtime.getURL('shared-ui/hc.css')).then(r=>r.text()).then(css=>respond({ok:true,css}),()=>respond({ok:false}));
  return true;
 }
 if(message?.type==='HCT_PO_REVIEW'){
  chrome.windows.create({url:chrome.runtime.getURL('po-companion/review.html'),type:'popup',width:980,height:800})
   .then(()=>respond({ok:true}),error=>respond({ok:false,error:error.message}));
  return true;
 }
 if(message?.type==='HCT_PO_LOGIN'||message?.type==='HCT_PO_LOAD'){
  respond({ok:false,error:'Read-only PO gateway is not enabled on this development branch.'});return;
 }
 if(message?.type==='HCT_PO_LOGOUT'){respond({ok:true});}
});
