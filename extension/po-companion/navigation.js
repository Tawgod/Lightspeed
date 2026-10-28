// PO Companion navigation uses the exact verified destination registry shared
// with the supplier panel. It does not add unverified feature launch routes.
(async()=>{
 const target=document.getElementById('hc-other-tools');
 if(!target)return;
 try{
  const response=await fetch('navigation.json',{cache:'no-store'});
  if(!response.ok)throw new Error('Navigation unavailable');
  const entries=await response.json();
  if(!Array.isArray(entries))throw new Error('Invalid navigation');
  for(const entry of entries){
   if(typeof entry.label!=='string'||typeof entry.url!=='string')continue;
   const a=document.createElement('a');
   a.href=entry.url;a.textContent=entry.label;a.target='_blank';a.rel='noopener noreferrer';
   a.className='hc-tool-link';
   target.append(a);
  }
 }catch{
  target.textContent='Other tools temporarily unavailable.';
 }
})();