// Headless Chrome layout smoke for extension-owned screens with browser APIs stubbed.
// No employee PIN or backend credentials; all remote requests blocked.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname, join, normalize } from 'node:path';
const root=resolve('extension');
const types={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.webp':'image/webp','.png':'image/png','.svg':'image/svg+xml'};
const server=createServer(async(req,res)=>{
 const name=normalize(decodeURIComponent((req.url||'/').split('?')[0])).replace(/^\/+/, '');
 const file=resolve(root,name);
 if(!file.startsWith(root+'/')){res.writeHead(403);return res.end();}
 try{const bytes=await readFile(file);res.writeHead(200,{'Content-Type':types[extname(file)]||'application/octet-stream'});res.end(bytes)}
 catch{res.writeHead(404);res.end();}
});
await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
const base='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({headless:true});
const results=[];
try {
 await mkdir('browser-smoke-artifacts',{recursive:true});
 for(const [file,width,height,current] of [
   ['popup.html',420,700,'Lightspeed Toolkit'],
   ['product-scanner/review.html',1400,900,'Product Scanner'],
   ['product-scanner/review.html',700,950,'Product Scanner']
 ]) {
  for(const zoom of [1,1.25,2]){
   const page=await browser.newPage({viewport:{width,height},deviceScaleFactor:1});
   const errors=[];
   page.on('pageerror',e=>errors.push(e.message));
   await page.route('https://**/*',route=>route.abort());
   await page.addInitScript(()=>{
     const storage={};
     window.chrome={
       runtime:{getURL:p=>'/'+p},
       tabs:{query:async()=>[],get:async()=>null,sendMessage:async()=>null},
       windows:{create:async()=>({})},
       permissions:{contains:async()=>false,request:async()=>false},
       storage:{local:{
        get:async keys=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,storage[k]])),
        set:async data=>Object.assign(storage,data),remove:async()=>{}
       }},
       scripting:{executeScript:async()=>[]}
     };
   });
   await page.goto(base+'/'+file,{waitUntil:'networkidle'});
   await page.evaluate(z=>{document.documentElement.style.zoom=String(z)},zoom);
   const nav=page.locator('#hc-shared-navigation');
   await nav.locator('[aria-current="page"]').waitFor();
   assert.equal((await nav.locator('[aria-current="page"]').innerText()).trim(),current);
   assert.equal(await nav.locator('a').count(),6);
   assert.equal(await page.locator('img[alt="Hobby Corner"]').count(),1);
   assert.equal(await page.locator('details.hc-extension-nav-more summary').count(),1);
   await nav.locator('details summary').click();
   assert.equal(await nav.locator('details').getAttribute('open'),'');
   await nav.locator('details summary').press('Escape');
   assert.equal(await nav.locator('details').getAttribute('open'),null);
   if(file.includes('review')){
     assert.equal(await page.locator('#employee-pin').count(),1);
     assert.equal(await page.locator('#create-item').isDisabled(),true);
   }else{
     for(const id of ['scan-page','split','combine'])assert.equal(await page.locator('#'+id).count(),1);
   }
   assert.equal(errors.length,0,'Script errors: '+errors.join('; '));
   const fileName=file.replaceAll('/','-')+'-'+width+'px-'+String(zoom).replace('.','_')+'x.png';
   await page.screenshot({path:join('browser-smoke-artifacts',fileName),fullPage:true});
   results.push(fileName);
   await page.close();
  }
 }
 console.log('Chrome UI layout smoke passed:',results.join(', '));
}finally{await browser.close();await new Promise(ok=>server.close(ok));}
