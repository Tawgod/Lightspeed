import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const base='http://127.0.0.1:8080';
const browser=await chromium.launch({headless:true});
try{
 await fs.mkdir('artifacts/consignment-browser',{recursive:true});
 for(const [name,path] of [['manager','/consignment'],['customer','/consignment/submit']]){
  for(const [width,height,zoom] of [[1440,900,1],[900,850,1.25],[390,844,2]]){
   const page=await browser.newPage({viewport:{width,height}});
   await page.goto(base+path,{waitUntil:'domcontentloaded'});
   await page.evaluate(z=>document.documentElement.style.zoom=String(z),zoom);
   await page.waitForTimeout(200);
   assert.equal(await page.locator('nav[aria-label="Hobby Corner tools"]').count(),1);
   assert.equal(await page.locator('img[alt="The Hobby Corner"]').count(),1);
   assert.equal(await page.locator('nav a[href="https://special-orders-test-production.up.railway.app/special-orders"]').count(),1);
   const more=page.locator('details.hc-consignment-more summary');
   await more.focus();await page.keyboard.press('Enter');
   assert.equal(await page.locator('details.hc-consignment-more').evaluate(el=>el.open),true);
   await page.screenshot({path:'artifacts/consignment-browser/'+name+'-'+width+'-'+Math.round(zoom*100)+'.png',fullPage:true});
   await page.close();
  }
 }
 const staff=await browser.newPage();
 await staff.goto(base+'/consignment');
 await staff.locator('[data-status="PENDING_REVIEW"]').click();
 await staff.locator('.bulk-check:not([disabled])').first().check();
 assert.equal(await staff.locator('#approve-selected').isDisabled(),false);
 await staff.close();
 const customer=await browser.newPage();
 await customer.goto(base+'/consignment/submit');
 assert.equal(await customer.locator('#customer-form').count(),1);
 await customer.locator('#add').click();
 assert.equal(await customer.locator('.item-card').count(),2);
 await customer.close();
}finally{await browser.close();}
