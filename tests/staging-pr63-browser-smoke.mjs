import {chromium} from 'playwright';
import assert from 'node:assert/strict';

const host='https://hc-foundation-pr63-staging.up.railway.app';
const prefix='/HobbyCorner';
const browser=await chromium.launch({headless:true});
try {
 const page=await browser.newPage({viewport:{width:1365,height:900}});
 const pageErrors=[];
 const missingResources=[];
 page.on('pageerror',e=>pageErrors.push(e.message));
 page.on('response',response=>{
  const url=response.url();
  if(url.startsWith(host+prefix+'/') && response.status()>=400
    && /\.(?:js|mjs|css|webp)(?:\?|$)/.test(url))
    missingResources.push({url,status:response.status()});
 });
 const result=await page.goto(host+prefix+'/store-operations',{
  waitUntil:'networkidle',timeout:45000
 });
 assert.equal(result?.status(),200);
 assert.match(await page.locator('h1').innerText(),/Store Operations Dashboard/);
 await page.locator('.hc-operations-links [data-tool-id="special-orders"]').first()
  .waitFor({state:'attached',timeout:15000});
 assert.equal(await page.locator('#authStatus').innerText(),'Signed out');
 assert.equal(await page.locator('#dashOpen').innerText(),'—');
 assert.equal(await page.locator('#refreshDashboard').isDisabled(),true);
 assert.equal(await page.locator('a[href*="employee-admin/"]').count(),0);
 for(const [id,path] of [
  ['home','store-operations'],['special-orders','special-orders'],
  ['preorders','preorders'],['gw-preorders','gw-preorders'],['ordering','ordering']
 ]){
  const link=page.locator('.hc-operations-links [data-tool-id="'+id+'"]').first();
  await link.waitFor({state:'attached'});
  const href=await link.evaluate(el=>el.href);
  assert.equal(new URL(href).pathname,prefix+'/'+path,
   'Incorrect same-origin nav destination '+id);
 }
 assert.deepEqual(missingResources,[],'Static assets must load under the prefix');
 assert.deepEqual(pageErrors,[],'No runtime JavaScript errors on dashboard');
 // Read-only browser navigation; do not submit test PIN or any mutation.
 const next=await page.goto(host+prefix+'/special-orders',{
  waitUntil:'networkidle',timeout:45000
 });
 assert.equal(next?.status(),200);
 assert.equal(await page.locator('#employeePin').count(),1);
 assert.deepEqual(missingResources,[],'Special Orders assets must load under the prefix');
 assert.deepEqual(pageErrors,[],'No runtime JavaScript errors on Special Orders');
 await page.close();
 console.log('PASS live staging Chromium: prefixed homepage, grouped links, signed-out guard, assets and Special Orders');
}finally{
 await browser.close();
}
