import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
const script=read('shared-ui/store-operations.mjs').replace(/^export /gm,'');
let html=read('store-operations.html');
const css=[read('shared-ui/hc.css'),read('shared-ui/core-ops-compat.css'),read('shared-ui/store-operations.css')].join('\n');
html=html.replace(/<link[^>]+rel="stylesheet"[^>]*>/g,'')
 .replace('</head>','<style>'+css+'</style></head>')
 .replace(/<script[\s\S]*?<\/script>/g,'');
const browser=await chromium.launch({headless:true});
try{
 const page=await browser.newPage({viewport:{width:1280,height:900}});
 await page.setContent(html,{waitUntil:'domcontentloaded'});
 await page.evaluate(()=>{
  let session=null;
  window.__priorityFail=false;
  window.HCStaffAuth={
   readSession:()=>session,employee:()=>session?.employee||null,
   async verify(){return session},
   async signIn(pin){
    if(pin!=='1234')throw Error('PIN rejected');
    session={token:'safe-test-token',employee:{name:'Test Employee'}};
    window.dispatchEvent(new Event('hc-staff-auth-changed'));
    return session;
   },
   signOut(){session=null;window.dispatchEvent(new Event('hc-staff-auth-changed'))}
  };
  window.fetch=async (url,options)=>{
   if(options?.headers?.Authorization!=='Bearer safe-test-token')
    return {status:401,ok:false,json:async()=>({})};
   if(url.includes('/priority-review')){
    if(window.__priorityFail)return {status:503,ok:false,json:async()=>({})};
    return {ok:true,status:200,json:async()=>({
     source:'special-orders',as_of:'2026-11-09T12:00:00Z',
     counts:{old_open_items:3,ordered_over_7_days:2,supplier_sync_failures:1,delivery_failures:0}
    })};
   }
   if(url.includes('/stats'))return {ok:true,status:200,json:async()=>({
    open:12,needs_ordering:4,ordered_over_7_days:2,preorder:5,ready_or_held:1,backordered:3
   })};
   return {ok:false,status:404,json:async()=>({})};
  };
 });
 await page.addScriptTag({content:script});
 await assert.equal(await page.locator('#dashOpen').textContent(),'—');
 await page.locator('#employeePin').fill('1234');
 await page.locator('#unlockButton').click();
 await page.waitForFunction(()=>document.querySelector('#dashOpen')?.textContent==='12');
 assert.equal(await page.locator('#reviewOld').textContent(),'3');
 assert.equal(await page.locator('#reviewDelivery').textContent(),'0');
 assert.match(await page.locator('#prioritySummary').textContent(),/3 categories need review/);
 assert.match(await page.locator('#statsCoverage').textContent(),/Available/);
 assert.equal(await page.locator('#signOutButton').isVisible(),true);
 await page.evaluate(()=>{window.__priorityFail=true});
 await page.locator('#refreshDashboard').click();
 await page.waitForFunction(()=>document.querySelector('#prioritySummary')?.textContent==='Review unavailable');
 assert.equal(await page.locator('#reviewOld').textContent(),'—');
 assert.equal(await page.locator('#dashOpen').textContent(),'12');
 await page.locator('#signOutButton').click();
 await page.waitForFunction(()=>document.querySelector('#dashOpen')?.textContent==='—');
 assert.equal(await page.locator('#refreshDashboard').isDisabled(),true);
 assert.equal(await page.locator('#reviewSync').textContent(),'—');
 await page.close();
}finally{await browser.close()}
console.log('Store Operations Home: authenticated counts, partial failure, stale clearing and sign-out passed');
