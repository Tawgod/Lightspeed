/* Shared web navigation registry. Only verified routes become links.
 * The Chrome extension has a different runtime; coordinate labels and
 * destinations with its owner instead of importing browser-host code. */
export const toolGroups = Object.freeze([
  {label:'Orders & Fulfillment',items:[
    {id:'special-orders',label:'Special Orders',href:'/special-orders',children:[
      {id:'preorders',label:'Preorder Campaigns',href:'/preorders'},
      {id:'gw-preorders',label:'GW Preorders',href:'/gw-preorders'}
    ]}
  ]},
  {label:'Purchasing',items:[
    {id:'ordering',label:'Ordering',href:'/ordering'}
  ]},
  {label:'Store Tools',items:[
    {id:'toolkit',label:'Lightspeed Toolkit',href:'https://lightspeed-api-production-c087.up.railway.app/extension',external:true},
    {id:'consignment',label:'Consignment Manager',href:'https://consignment-beta-test.up.railway.app/consignment',external:true,beta:true}
  ]}
]);
export const allDestinations = toolGroups.flatMap(g=>g.items.flatMap(i=>[i,...(i.children||[])]));
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
    for(const item of group.items) {
      menu.append(makeLink(item,current));
      for(const child of item.children||[]){
        const childLink=makeLink(child,current);
        childLink.classList.add('hc-nav-child');
        menu.append(childLink);
      }
    }
    details.append(summary,menu);
    if(group.items.some(x=>x.id===current||(x.children||[]).some(y=>y.id===current)))details.classList.add('hc-nav-current-group');
    fragment.append(details);
  }
  // Every page has the full directory, but dependent tools sit under their parent.
  target.replaceChildren(fragment);
  const closeOtherMenus=e=>{
    const item=e.target.closest?.('details.hc-nav-group');
    if(!item||!e.target.matches('summary'))return;
    for(const other of target.querySelectorAll('details.hc-nav-group'))if(other!==item)other.open=false;
  };
  target.addEventListener('click',closeOtherMenus);
  target.addEventListener('keydown',e=>{
    if(e.key==='Escape'){
      const opened=target.querySelector('details[open]');
      if(opened){opened.open=false;opened.querySelector('summary').focus();e.preventDefault();}
    }
  });
  return true;
}
if(typeof document!=='undefined')renderOperationsNav();
