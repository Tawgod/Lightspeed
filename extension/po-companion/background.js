// PO Companion isolated review opener. No backend mutation or employee token storage.
chrome.runtime.onMessage.addListener((message,_sender,respond)=>{
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
