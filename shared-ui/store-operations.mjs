/* Store Operations Home: existing read-only Special Orders API only.
 * Do not infer system health, activity, or permissions from navigation. */
export const kpiMap=Object.freeze({
 open:'dashOpen',needs_ordering:'dashOrdering',
 ordered_over_7_days:'dashInTransit',preorder:'dashPreorders',
 ready_or_held:'dashHeld'
});
export const reviewMap=Object.freeze({
 old_open_items:'reviewOld',ordered_over_7_days:'reviewOrdered',
 supplier_sync_failures:'reviewSync',delivery_failures:'reviewDelivery'
});
export function verifiedCounts(data,keys){
 if(!data||typeof data!=='object'||!keys.every(k=>Number.isSafeInteger(data[k])&&data[k]>=0))
   throw new Error('The server returned incomplete dashboard counts.');
 return Object.fromEntries(keys.map(k=>[k,data[k]]));
}
export function formatUpdated(asOf){
 const date=new Date(asOf);
 return Number.isFinite(date.getTime())?'Updated '+date.toLocaleString():'Update time unavailable';
}
function el(id){return document.getElementById(id)}
function setText(id,value){const node=el(id);if(node)node.textContent=String(value)}
function clearNumbers(){
 for(const id of [...Object.values(kpiMap),...Object.values(reviewMap),
  'summaryOrdering','summaryBackordered','summaryOrdered','summaryHeld'])setText(id,'—');
 setText('prioritySummary','Awaiting data');
 setText('statsCoverage','Not loaded');
 setText('priorityCoverage','Not loaded');
 setText('dashboardUpdated','Sign in to view current data.');
}
let requestGeneration=0;
let signedIn=false;
function setSignedIn(active){
 signedIn=Boolean(active);
 const node=el('authStatus');
 if(node)node.textContent=signedIn?'Signed in':'Signed out';
 const employee=window.HCStaffAuth?.employee?.();
 setText('authEmployee',signedIn&&employee?.name?'Signed in as '+employee.name:'');
 const signOut=el('signOutButton');if(signOut)signOut.hidden=!signedIn;
 const refresh=el('refreshDashboard');if(refresh)refresh.disabled=!signedIn;
 if(!signedIn){
  requestGeneration++;
  clearNumbers();
 }
}
function showError(text){
 const box=el('dashboardError');
 if(!box)return;
 box.hidden=!text;
 box.textContent=text||'';
}
async function getProtectedJson(url,session){
 const response=await fetch(url,{
  method:'GET',cache:'no-store',credentials:'omit',redirect:'error',
  headers:{Accept:'application/json',Authorization:'Bearer '+session.token}
 });
 if(response.status===401||response.status===403){
  const error=new Error('Employee session expired or access denied. Sign in again.');
  error.code='AUTH';
  throw error;
 }
 if(!response.ok)throw new Error('Data source unavailable.');
 return response.json();
}
export async function loadDashboard(){
 const current=++requestGeneration;
 if(!signedIn)return;
 const session=window.HCStaffAuth?.readSession?.();
 if(!session?.token){setSignedIn(false);return}
 showError('');
 setText('dashboardUpdated','Refreshing…');
 const queries=await Promise.allSettled([
  getProtectedJson('/api/special-orders/stats',session),
  getProtectedJson('/api/special-orders/priority-review',session)
 ]);
 if(current!==requestGeneration||!signedIn)return;
 if(queries.some(q=>q.status==='rejected'&&q.reason?.code==='AUTH')){
  window.HCStaffAuth?.signOut?.();
  setSignedIn(false);
  showError('Employee session expired or access was denied. Sign in again.');
  return;
 }
 const stats=queries[0],priority=queries[1];
 let anyLoaded=false;
 if(stats.status==='fulfilled'){
  try{
   const required=[...Object.keys(kpiMap),'backordered'];
   const counts=verifiedCounts(stats.value,required);
   for(const [key,id] of Object.entries(kpiMap))setText(id,counts[key]);
   setText('summaryOrdering',counts.needs_ordering);
   setText('summaryBackordered',counts.backordered);
   setText('summaryOrdered',counts.ordered_over_7_days);
   setText('summaryHeld',counts.ready_or_held);
   setText('statsCoverage','Available');
   anyLoaded=true;
  }catch{setText('statsCoverage','Unavailable');}
 }else setText('statsCoverage','Unavailable');
 if(priority.status==='fulfilled'){
  try{
   if(priority.value?.source!=='special-orders')throw new Error('Wrong source');
   const counts=verifiedCounts(priority.value.counts,Object.keys(reviewMap));
   for(const [key,id] of Object.entries(reviewMap))setText(id,counts[key]);
   const categories=Object.values(counts).filter(n=>n>0).length;
   setText('prioritySummary',categories?categories+' categories need review':'No flags in checked categories');
   setText('priorityCoverage',formatUpdated(priority.value.as_of));
   anyLoaded=true;
  }catch{setText('priorityCoverage','Unavailable');setText('prioritySummary','Review unavailable');}
 }else{setText('priorityCoverage','Unavailable');setText('prioritySummary','Review unavailable')}
 setText('dashboardUpdated',anyLoaded?'Last check: '+new Date().toLocaleString():'Data unavailable');
 if(!anyLoaded)showError('Dashboard data is unavailable. Your orders were not changed.');
}
async function signIn(){
 const pin=el('employeePin')?.value?.trim();
 try{
  if(!window.HCStaffAuth?.signIn)throw new Error('Staff sign-in is unavailable.');
  await window.HCStaffAuth.signIn(pin);
  if(el('employeePin'))el('employeePin').value='';
  setSignedIn(true);
  await loadDashboard();
 }catch(error){setSignedIn(false);showError(error.message||'Could not sign in.')}
}
function signOut(){
 window.HCStaffAuth?.signOut?.();
 setSignedIn(false);
 showError('');
}
export async function initializeDashboard(){
 setSignedIn(false);
 el('unlockButton')?.addEventListener('click',signIn);
 el('employeePin')?.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();void signIn();}});
 el('signOutButton')?.addEventListener('click',signOut);
 el('refreshDashboard')?.addEventListener('click',()=>{void loadDashboard();});
 window.addEventListener('hc-staff-auth-changed',()=>{
  if(!window.HCStaffAuth?.readSession?.()){setSignedIn(false);showError('');}
 });
 try{
  const existing=await window.HCStaffAuth?.verify?.();
  if(existing?.token){setSignedIn(true);await loadDashboard()}
 }catch{setSignedIn(false)}
}
if(typeof document!=='undefined'){
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>{void initializeDashboard()},{once:true});
 else void initializeDashboard();
}
