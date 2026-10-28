import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {destinations} from '../extension/shared-ui/navigation.mjs';
const read=p=>fs.readFileSync(p,'utf8');
test('scanner links only to PR23 verified core routes and extension-owned tools',()=>{
 assert.deepEqual(destinations.map(d=>d.label),['Special Orders','Ordering','Preorder Campaigns','GW Preorders','Product Scanner','Lightspeed Toolkit']);
 for(const [id,route] of [['special-orders','/special-orders'],['ordering','/ordering'],['preorders','/preorders'],['gw-preorders','/gw-preorders']]){
  const d=destinations.find(x=>x.id===id);
  assert.equal(new URL(d.href).pathname,route);
  assert.equal(new URL(d.href).hostname,'lightspeed-api-production-c087.up.railway.app');
 }
 assert.equal(destinations.find(x=>x.id==='product-scanner').local,'product-scanner/review.html');
 assert.equal(destinations.find(x=>x.id==='toolkit').local,'popup.html');
 assert.ok(destinations.every(x=>!/(consignment|companion|manager|timeclock|split)/i.test(x.id)));
});
test('scanner and toolkit use one shared nav module; existing business controls remain',()=>{
 const review=read('extension/product-scanner/review.html');
 const popup=read('extension/popup.html');
 const reviewJs=read('extension/product-scanner/review.js');
 const popupJs=read('extension/popup.js');
 for(const html of [review,popup]){
  assert.match(html,/id="hc-shared-navigation"/);
  assert.match(html,/shared-ui\/navigation.css/);
  assert.match(html,/hc-wordmark\.webp/);
 }
 for(const js of [reviewJs,popupJs])assert.match(js,/installHobbyCornerNavigation/);
 for(const id of ['employee-pin','scan-open-supplier','check-matches','preorder-campaign','stage-preorder','submit-product-proposal','create-item'])assert.ok(review.includes('id="'+id+'"'));
 for(const id of ['scan-page','detect','split','combine'])assert.ok(popup.includes('id="'+id+'"'));
 assert.match(review,/id="create-item" disabled/);
 assert.ok(!reviewJs.includes('api/2026-07/products'));
});
test('accessible More menu, active-page semantics and exit without losing focus',()=>{
 const source=read('extension/shared-ui/navigation.mjs');
 const css=read('extension/shared-ui/navigation.css');
 assert.match(source,/aria-current/);
 assert.match(source,/aria-label/);
 assert.match(source,/Escape/);
 assert.match(source,/summary\.focus\(\)/);
 assert.match(css,/focus-visible/);
 assert.match(css,/max-width:650px/);
 assert.match(css,/hc-surface-inset/);
});
test('copied product identifiers use the common exact source-preserving helper',()=>{
 const js=read('extension/product-scanner/review.js');
 assert.match(js,/copyHobbyCornerField/);
 assert.ok(fs.existsSync('extension/shared-ui/clipboard.mjs'));
});
