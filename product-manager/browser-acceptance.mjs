import {chromium} from 'playwright';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=process.cwd();
const mime={'.html':'text/html','.mjs':'text/javascript','.js':'text/javascript','.css':'text/css','.webp':'image/webp'};
const server=http.createServer(async(req,res)=>{
 const rel=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
 const file=path.resolve(root,'.'+rel);
 if(!(file===root||file.startsWith(root+path.sep))){res.writeHead(403);return res.end()}
 try{const content=await fs.readFile(file);res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream'});res.end(content)}
 catch{res.writeHead(404);res.end('Not found')}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({headless:true});
const base='http://127.0.0.1:'+server.address().port+'/product-manager/index.html';
try{
 const page=await browser.newPage({viewport:{width:1365,height:900}});
 const failures=[];page.on('pageerror',e=>failures.push(e.message));
 await page.goto(base);await page.locator('#rows tr').first().waitFor();
 assert.equal(await page.locator('#rows tr').count(),3,'inactive is hidden by default');
 await page.locator('#query').fill('00012345');
 assert.equal(await page.locator('#rows tr').count(),1,'leading-zero search');
 await page.locator('#query').fill('NOTFOUND');
 assert.equal(await page.locator('#rows tr').count(),0,'empty result');
 assert.equal(await page.locator('#empty').isVisible(),true);
 await page.locator('#query').fill('');
 await page.locator('#hide-inactive').uncheck();
 assert.equal(await page.locator('#rows tr').count(),4,'inactive toggle');
 await page.locator('#view').selectOption('edit');
 await page.locator('#edit-name').fill('Updated demo title');
 await page.locator('#edit-price').fill('33.95');
 await page.locator('#edit-online').selectOption('true');
 await page.locator('#stage-fields').click();
 assert.equal(await page.locator('[data-undo]').count(),3,'three staged fields');
 assert.match(await page.locator('#review-list').innerText(),/Updated demo title/);
 await page.locator('[data-undo]').first().click();
 assert.equal(await page.locator('[data-undo]').count(),2,'single field undo');
 await page.locator('#view').selectOption('edit');
 await page.locator('#edit-price').fill('not-money');
 await page.locator('#stage-fields').click();
 assert.match(await page.locator('#feedback').innerText(),/Validation failed/);
 assert.equal(await page.locator('[data-undo]').count(),2,'invalid edit does not change drafts');
 await page.locator('#reset').click();
 assert.equal(await page.locator('[data-undo]').count(),0,'reset drafts');
 await page.locator('#rows tr').first().focus();await page.keyboard.press('Enter');
 assert.equal(await page.locator('#view').inputValue(),'summary','keyboard row activation');
 for(const z of [1,1.25,2]){
   await page.setViewportSize({width:1100,height:800});
   await page.evaluate(n=>document.documentElement.style.zoom=String(n),z);
   assert.equal(await page.locator('#rows').isVisible(),true,'grid visible at visual zoom '+z);
   assert.equal(await page.locator('#detail').isVisible(),true,'detail visible at visual zoom '+z);
 }
 await page.setViewportSize({width:600,height:780});
 assert.equal(await page.locator('.pm-layout').evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length),1,'mobile stacked layout');
 assert.equal(failures.length,0,failures.join(';'));
 console.log('PASS Chromium: search, inactive filter, empty state, three-field drafts, undo, invalid input, reset, keyboard row activation, responsive stack; CSS visual zoom 100/125/200.');
 console.log('NOTE Native browser menu zoom, authenticated navigation and real API flows require manual acceptance.');
}finally{await browser.close();await new Promise(r=>server.close(r))}
