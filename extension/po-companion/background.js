// Only navigation into bundled review UI. No Lightspeed writes.
chrome.runtime.onMessage.addListener(message=>{
 if(message?.type==='HCT_PO_REVIEW'){
   chrome.windows.create({url:chrome.runtime.getURL('po-companion/review.html'),type:'popup',width:980,height:800});
 }
});
