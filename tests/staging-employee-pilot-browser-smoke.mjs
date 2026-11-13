import assert from 'node:assert/strict';
import {chromium} from 'playwright';

// No PIN, operator key, credential or business POST is submitted here.
// This checks actual browser rendering, secure-context WebCrypto Ed25519,
// navigational assets, and signed-out / denied UI.
const origin='https://hc-employee-pilot-test.up.railway.app';
const browser=await chromium.launch({headless:true});
try{
  const page=await browser.newPage({viewport:{width:390,height:844}});
  const errors=[],resources=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('response',response=>{
    const u=new URL(response.url());
    if(u.origin===origin&&['/HobbyCorner/pilot.js','/HobbyCorner/pilot.css'].includes(u.pathname))
      resources.push({path:u.pathname,status:response.status()});
  });
  const response=await page.goto(origin+'/HobbyCorner/',{waitUntil:'networkidle',timeout:20_000});
  assert.equal(response?.status(),200);
  assert.equal(await page.title(),'Hobby Corner · Isolated employee read pilot');
  assert.equal(await page.locator('h1').textContent(),'Employee read-access pilot');
  assert.equal(await page.locator('#login').count(),1);
  assert.equal(await page.locator('#register').count(),1);
  assert.equal(await page.locator('#prove').count(),1);
  assert.equal(await page.locator('#orders').count(),1);
  const device=await page.evaluate(async()=>{
    const pair=await crypto.subtle.generateKey({name:'Ed25519'},false,['sign','verify']);
    const publicSpki=await crypto.subtle.exportKey('spki',pair.publicKey);
    return {privateExtractable:pair.privateKey.extractable,publicBytes:publicSpki.byteLength};
  });
  assert.deepEqual(device,{privateExtractable:false,publicBytes:44});
  const width=await page.evaluate(()=>({
    scroll:document.documentElement.scrollWidth,visible:document.documentElement.clientWidth
  }));
  assert.ok(width.scroll<=width.visible+2,'Mobile page must not overflow horizontally');
  for(const path of ['/HobbyCorner/pilot.js','/HobbyCorner/pilot.css']){
    assert.ok(resources.some(r=>r.path===path&&r.status===200),'Missing '+path);
  }
  assert.deepEqual(errors,[]);
  console.log('PASS real Chromium isolated pilot HTML, JS, CSS, mobile layout, signed-out controls, non-exportable Ed25519');
}finally{await browser.close();}
