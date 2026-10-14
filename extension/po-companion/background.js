// PO Companion extension-owned authenticated requests. No supplier page receives PINs or tokens.
const API='https://special-orders-test-production.up.railway.app/api/scanner';
let session=null;
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
 if(message?.type==='HCT_PO_REVIEW'){
   chrome.windows.create({url:chrome.runtime.getURL('po-companion/review.html'),type:'popup',width:980,height:800});
   return;
 }
 if(!['HCT_PO_LOGIN','HCT_PO_LOAD','HCT_PO_LOGOUT'].includes(message?.type))return;
 (async()=>{
  if(!sender?.tab?.id)throw new Error('Only an active supplier page may use PO Companion.');
  if(message.type==='HCT_PO_LOGOUT'){session=null;return {ok:true};}
  if(message.type==='HCT_PO_LOGIN'){
   const pin=String(message.pin||'');
   if(!/^\d{4}$/.test(pin))throw new Error('Enter a four-digit Timeclock PIN.');
   const result=await fetch(API+'/session',{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin})});
   if(!result.ok)throw new Error(result.status===429?'Too many sign-in attempts.': 'Employee sign-in rejected ('+result.status+').');
   const data=await result.json();
   if(!data?.token||!data?.employee?.canLookup)throw new Error('Employee is not authorized.');
   session={token:data.token,expires:Date.now()+data.expiresIn*1000};
   return {ok:true,employee:{name:data.employee.name,canLookup:true,canApprove:!!data.employee.canApprove}};
  }
  if(!session||Date.now()>=session.expires)throw new Error('Please sign in using your Timeclock PIN.');
  const poId=String(message.poId||'');
  if(!/^[a-z0-9_-]{1,100}$/i.test(poId))throw new Error('Invalid PO ID.');
  const res=await fetch(API+'/purchase-orders/'+encodeURIComponent(poId),{
   cache:'no-store',headers:{Authorization:'Bearer '+session.token}});
  if(res.status===401||res.status===403)session=null;
  const data=await res.json().catch(()=>({}));
  if(!res.ok)throw new Error(data.error||'PO load failed ('+res.status+').');
  if(data.readOnly!==true||data.purchaseOrder?.id!==poId||!Array.isArray(data.items))throw new Error('Invalid PO response.');
  return {ok:true,data};
 })().then(respond,e=>respond({ok:false,error:e.message}));return true;
});
