// Chrome-extension adapter to the shared PR #23 operations navigation.
// Only established server.js routes and installed-extension pages are linked.
// Unreleased tool destinations remain absent, not silently redirected.
const operationsOrigin='https://lightspeed-api-production-c087.up.railway.app';
export const destinations=Object.freeze([
  {id:'special-orders',label:'Special Orders',href:operationsOrigin+'/special-orders'},
  {id:'ordering',label:'Ordering',href:operationsOrigin+'/ordering'},
  {id:'preorders',label:'Preorder Campaigns',href:operationsOrigin+'/preorders'},
  {id:'gw-preorders',label:'GW Preorders',href:operationsOrigin+'/gw-preorders'},
  {id:'product-scanner',label:'Product Scanner',local:'product-scanner/review.html'},
  {id:'toolkit',label:'Lightspeed Toolkit',local:'popup.html'}
]);
export function installHobbyCornerNavigation(nav,{current,extensionUrl=path=>chrome.runtime.getURL(path)}={}){
  if(!nav)return;
  nav.setAttribute('aria-label','Hobby Corner tools');
  nav.classList.add('hc-extension-nav');
  nav.replaceChildren();
  const primary=document.createElement('div');primary.className='hc-extension-nav-primary';
  const more=document.createElement('details');more.className='hc-extension-nav-more';
  const summary=document.createElement('summary');summary.textContent='More tools';more.append(summary);
  const overflow=document.createElement('div');overflow.className='hc-extension-nav-overflow';more.append(overflow);
  for(const item of destinations){
    const a=document.createElement('a');
    a.textContent=item.label;
    a.href=item.local?extensionUrl(item.local):item.href;
    if(item.local!==undefined){a.target='_blank';a.rel='noopener noreferrer';}
    else {a.target='_blank';a.rel='noopener noreferrer';}
    if(item.id===current){a.setAttribute('aria-current','page');a.removeAttribute('target');}
    if(item.id===current || ['special-orders','ordering','product-scanner'].includes(item.id)){
      primary.append(a);
    }else overflow.append(a);
  }
  nav.append(primary,more);
  const close=event=>{
    if(!more.open)return;
    if(event.key==='Escape'){more.open=false;summary.focus();}
  };
  more.addEventListener('keydown',close);
  more.addEventListener('toggle',()=>{if(more.open)summary.setAttribute('aria-expanded','true');else summary.setAttribute('aria-expanded','false');});
}
