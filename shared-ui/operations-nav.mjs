/* Shared web navigation registry. Only verified routes become links.
 * The Chrome extension has a different runtime; coordinate labels and
 * destinations with its owner instead of importing browser-host code. */
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
export const allDestinations = toolGroups.flatMap(g=>g.items.flatMap(descendants));
function makeLink(item,current) {
  const a=document.createElement('a');
  a.href=item.href;
  a.textContent=item.label;
  a.dataset.toolId=item.id;
  if(item.id===current)a.setAttribute('aria-current','page');
  if(item.external){a.target='_blank';a.rel='noopener noreferrer';a.setAttribute('aria-label',item.label+(item.beta?' (beta test, opens a new tab)':' (opens a new tab)'));}
  if(item.beta){const tag=document.createElement('span');tag.className='hc-nav-beta';tag.textContent='Beta / Test';a.append(' ',tag);}
  return a;
}
export function renderOperationsNav(root=document) {
  const target=root.querySelector('.hc-operations-links');
  if(!target)return false;
  const current=target.dataset.currentTool;
  if(!allDestinations.some(t=>t.id===current))return false;
  const fragment=root.createDocumentFragment();
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
  const closeOtherMenus=e=>{
    const item=e.target.closest?.('details.hc-nav-group');
    if(!item||!e.target.matches('summary'))return;
    for(const other of target.querySelectorAll('details.hc-nav-group'))if(other!==item)other.open=false;
  };
  if(target.dataset.navInitialized==='true')return true;
  target.dataset.navInitialized='true';
  target.addEventListener('click',closeOtherMenus);
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
