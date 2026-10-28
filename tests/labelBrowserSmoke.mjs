import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const root = process.cwd();
const fixture=[{name:'Synthetic Model Kit',sku:'0000412305',qty:3,autoSoQty:1,autoCustomerName:'Sample Customer',price:'$8.99'}];
const routes = new Map([
 ['/index.html',['text/html','index.html']],
 ['/label-ui/hc.css',['text/css','shared-ui/hc.css']],
 ['/label-ui/hc-wordmark.webp',['image/webp','extension/product-scanner/hc-wordmark.webp']]
]);
const server=createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname==='/api/templates'){res.setHeader('content-type','application/json');res.end(JSON.stringify([{id:'Avery_5960',name:'Avery 5960'}]));return;}
 if(url.pathname==='/api/po/TEST123/data'){res.setHeader('content-type','application/json');res.end(JSON.stringify(fixture));return;}
 const route=routes.get(url.pathname);
 if(!route){res.writeHead(404);res.end('Not found');return;}
 try {res.setHeader('content-type',route[0]);res.end(await readFile(resolve(root,route[1])));}
 catch(e){res.writeHead(500);res.end(String(e));}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const port=server.address().port;
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
try {
 const page=await browser.newPage({viewport:{width:1280,height:800}});
 const errors=[];
 page.on('pageerror',e=>errors.push(String(e)));
 await page.goto('http://127.0.0.1:'+port+'/index.html?poId=TEST123');
 await page.locator('#itemsBody tr').first().waitFor();
 assert.equal(await page.locator('#itemsBody tr').count(),1);
 assert.equal(await page.locator('#itemsBody .hc-mono').innerText(),'0000412305','SKU leading zeros preserved');
 assert.equal(await page.locator('#custName-0').inputValue(),'Sample Customer');
 await page.locator('#qty-0').fill('2');
 assert.equal(await page.locator('#qty-0').inputValue(),'2');
 await page.keyboard.press('Tab');
 assert.equal(await page.evaluate(()=>document.activeElement?.id),'soQty-0','Tab moves to next editable item');
 await page.keyboard.press('Shift+Tab');
 assert.equal(await page.evaluate(()=>document.activeElement?.id),'qty-0','Shift+Tab restores previous control');
 for(const zoom of [1,1.25,2]) {
   await page.evaluate(z=>document.documentElement.style.zoom=String(z),zoom);
   await page.locator('#generateBtn').scrollIntoViewIfNeeded();
   assert.equal(await page.locator('#generateBtn').isVisible(),true);
   assert.equal(await page.locator('#templateSelect').count(),1);
   console.log('PASS synthetic desktop CSS zoom '+Math.round(zoom*100)+'%');
 }
 await page.setViewportSize({width:390,height:844});
 await page.evaluate(()=>document.documentElement.style.zoom='1');
 assert.equal(await page.locator('#generateBtn').isVisible(),true);
 assert.equal(await page.locator('.hc-table-scroll').evaluate(x=>getComputedStyle(x).overflowX),'auto');
 console.log('PASS narrow layout, scrollable table, focus navigation and identifier fidelity');
 assert.deepEqual(errors,[]);
 console.log('PASS no browser page errors');
} finally {
 await browser.close();
 await new Promise(resolve=>server.close(resolve));
}
