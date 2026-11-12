/* Shared web navigation registry. Only verified routes become links.
 * The Chrome extension has a different runtime; coordinate labels and
 * destinations with its owner instead of importing browser-host code. */
export const homeDestination=Object.freeze({id:'home',label:'Home / Dashboard',href:'/store-operations'});
export const toolGroups = Object.freeze([
  {label:'Special Orders',items:[
    {id:'special-orders',label:'Special Orders Dashboard',href:'/special-orders',children:[
      {id:'preorders',label:'Preorders',href:'/preorders',children:[
        {id:'gw-preorders',label:'GW Preorders',href:'/gw-preorders'}
      ]},
      {id:'ordering',label:'Purchasing / Ordering',href:'/ordering'}
    ]}
  ]},
  {label:'Store Tools',items:[
    {id:'toolkit',label:'Lightspeed Toolkit',href:'https://lightspeed-api-production-c087.up.railway.app/extension',external:true},
    {id:'consignment',label:'Consignment Manager',href:'https://consignment-beta-test.up.railway.app/consignment',external:true,beta:true}
  ]}
]);
// Recursively flatten nested tools so any existing page can mark its location.
const descendants=item=>[item,...(item.children||[]).flatMap(descendants)];
export const allDestinations = [homeDestination,...toolGroups.flatMap(g=>g.items.flatMap(descendants))];

// Administrator navigation remains absent unless THIS origin's trusted
// backend independently confirms the exact admin.read grant for the current
// authenticated employee. Never trust browser sessionStorage/role labels.
export const adminDestination=Object.freeze({
 id:'employee-admin',label:'Employee Administration',href:'/employee-admin/'
});
export async function canShowAdminNavigation(fetchImpl,staffAuth=typeof window!=='undefined'?window.HCStaffAuth:null){
 if(typeof fetchImpl!=='function'||typeof staffAuth?.readSession!=='function'||
    typeof staffAuth?.headers!=='function'||!staffAuth.readSession())return false;
 try{
  const headers=staffAuth.headers({Accept:'application/json'});
  if(typeof headers?.Authorization!=='string'||!headers.Authorization.startsWith('Bearer '))return false;
  const response=await fetchImpl(publicOperationsPath('/api/admin/navigation-access'),{
   method:'GET',cache:'no-store',credentials:'omit',redirect:'error',
   headers
  });
  if(!response?.ok)return false;
  const result=await response.json();
  return result?.allowed===true && result?.authenticated===true &&
   result?.operation==='admin.read';
 }catch{return false;}
}

// Keep registered, same-origin destinations under the Timcorp prefix.
// External URLs are passed through unchanged; this is not an auth grant.
export function publicOperationsPath(path,baseHref=typeof document!=='undefined' &&
  typeof document.baseURI==='string' ? document.baseURI : 'https://example.invalid/'){
 if(typeof path!=='string'||!path.startsWith('/')||path.startsWith('//'))return path;
 // Playwright setContent, detached documents and server-side tests may
 // report about:blank or no usable origin. They retain the legacy root URLs.
 let safeBase='https://example.invalid/';
 try{
  const parsed=new URL(baseHref);
  if(parsed.protocol==='http:'||parsed.protocol==='https:')safeBase=parsed.href;
 }catch{}
 const resolved=new URL(path.slice(1),safeBase);
 return resolved.pathname+resolved.search+resolved.hash;
}

function makeLink(item,current) {
  const a=document.createElement('a');
  a.href=item.external?item.href:publicOperationsPath(item.href);
  a.textContent=item.label;
  a.dataset.toolId=item.id;
  if(item.id===current)a.setAttribute('aria-current','page');
  if(item.external){a.target='_blank';a.rel='noopener noreferrer';a.setAttribute('aria-label',item.label+(item.beta?' (beta test, opens a new tab)':' (opens a new tab)'));}
  if(item.beta){const tag=document.createElement('span');tag.className='hc-nav-beta';tag.textContent='Beta / Test';a.append(' ',tag);}
  return a;
}
export async function refreshAdminNavigation(root=document,fetchImpl=typeof fetch==='function'?fetch:null){
 const nav=root.querySelector('.hc-operations-links');
 if(!nav)return false;
 // The previous link is removed before every re-check to avoid stale admin
 // visibility after sign-out, expiry or a revoked server permission.
 for(const node of Array.from(nav.querySelectorAll('[data-hc-admin-group]')))node.remove();
 const epoch=String((Number(nav.dataset.adminCheckEpoch)||0)+1);
 nav.dataset.adminCheckEpoch=epoch;
 const allowed=await canShowAdminNavigation(fetchImpl);
 if(!allowed||nav.dataset.adminCheckEpoch!==epoch||root.hidden)return false;
 const group=root.createElement('details');
 group.className='hc-operations-more hc-nav-group';
 group.dataset.hcAdminGroup='true';
 const summary=root.createElement('summary');
 summary.textContent='Administration';
 const menu=root.createElement('div');
 menu.className='hc-operations-menu';
 menu.append(makeLink(adminDestination,nav.dataset.currentTool));
 group.append(summary,menu);
 nav.append(group);
 return true;
}

export function renderOperationsNav(root=document) {
  const target=root.querySelector('.hc-operations-links');
  if(!target)return false;
  const current=target.dataset.currentTool;
  if(!allDestinations.some(t=>t.id===current))return false;
  const fragment=root.createDocumentFragment();
  const homeLink=makeLink(homeDestination,current);
  homeLink.classList.add('hc-nav-home-link');
  fragment.append(homeLink);
  for(const group of toolGroups){
    const details=root.createElement('details');
    details.className='hc-operations-more hc-nav-group';
    const summary=root.createElement('summary');
    summary.textContent=group.label;
    const menu=root.createElement('div');
    menu.className='hc-operations-menu';
    const appendItem=(item,depth=0)=>{
      const link=makeLink(item,current);
      if(depth>0){link.classList.add('hc-nav-child');link.dataset.depth=String(depth);}
      menu.append(link);
      for(const child of item.children||[])appendItem(child,depth+1);
    };
    for(const item of group.items)appendItem(item);
    details.append(summary,menu);
    if(group.items.flatMap(descendants).some(x=>x.id===current))details.classList.add('hc-nav-current-group');
    fragment.append(details);
  }
  // Every page has the full directory, but dependent tools sit under their parent.
  target.replaceChildren(fragment);
  // The regular navigation renders immediately; admin is added only after a
  // fresh same-origin server grant check, never from employee session claims.
  void refreshAdminNavigation(root);
  const closeOtherMenus=e=>{
    const item=e.target.closest?.('details.hc-nav-group');
    if(!item||!e.target.matches('summary'))return;
    for(const other of target.querySelectorAll('details.hc-nav-group'))if(other!==item)other.open=false;
  };
  if(target.dataset.navInitialized==='true')return true;
  target.dataset.navInitialized='true';
  target.addEventListener('click',closeOtherMenus);
  if(root.addEventListener){
    // HCStaffAuth emits on window, not document. Listen on the same target
    // so explicit sign-out immediately revokes the navigation link.
    if(typeof window!=='undefined'&&typeof window.addEventListener==='function')
      window.addEventListener('hc-staff-auth-changed',()=>{void refreshAdminNavigation(root);});
    root.addEventListener('visibilitychange',()=>{
      if(root.hidden){
        for(const node of Array.from(target.querySelectorAll('[data-hc-admin-group]')))node.remove();
        target.dataset.adminCheckEpoch=String((Number(target.dataset.adminCheckEpoch)||0)+1);
      }else void refreshAdminNavigation(root);
    });
  }
  target.addEventListener('keydown',e=>{
    if(e.key==='Escape'){
      const opened=target.querySelector('details[open]');
      if(opened){opened.open=false;opened.querySelector('summary').focus();e.preventDefault();}
    }
  });
  return true;
}
// A module script is normally deferred, but keep startup safe for dynamic embedding
// and navigation opened before the page shell is constructed.
if(typeof document!=='undefined'){
  if(document.readyState==='loading'){
    document.addEventListener('DOMContentLoaded',()=>renderOperationsNav(),{once:true});
  }else{
    renderOperationsNav();
  }
}
