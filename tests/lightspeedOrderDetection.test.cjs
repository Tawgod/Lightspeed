const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const source=fs.readFileSync('extension/content.js','utf8');
const start=source.indexOf('function extractSaleRef() {');
const end=source.indexOf('\nfunction ensurePoLabelButton()',start);
assert.ok(start>=0&&end>start);
const snippet=source.slice(start,end);
function detect(url,{headings=[],labels=[],text=''}={}){
 const location=new URL(url);
 const document={
   body:{innerText:text},
   querySelectorAll(selector){
     if(selector==='h1,h2,h3,[role="heading"]')return headings.map(v=>({textContent:v}));
     if(selector.includes('invoice'))return labels.map(v=>({textContent:v,value:v,getAttribute(){return ''}}));
     return [];
   }
 };
 const fn=vm.runInNewContext('('+snippet.replace('function extractSaleRef','function')+')',{location,document,URLSearchParams,RegExp,String});
 return fn();
}
test('detects Lightspeed UUID sale route',()=>{
 const uuid='12345678-1234-4234-9234-123456789abc';
 assert.equal(detect('https://store.retail.lightspeed.app/redirect/1.0/sales/'+uuid+'?platform=web'),uuid);
});
test('detects numbered invoice via page heading',()=>{
 assert.equal(detect('https://store.retail.lightspeed.app/webregister',{headings:['Invoice #1542']}),'1542');
});
test('detects numeric URL invoice and query parameter',()=>{
 assert.equal(detect('https://store.retail.lightspeed.app/sales/1234'),'1234');
 assert.equal(detect('https://store.retail.lightspeed.app/webregister?invoice_number=2501'),'2501');
});
test('does not confuse purchase order with customer sale',()=>{
 assert.equal(detect('https://store.retail.lightspeed.app/inventory/purchase-order/xyz',{headings:['Purchase Order #1042']}),'');
});
test('does not pick generic unrelated order numbers from product text',()=>{
 assert.equal(detect('https://store.retail.lightspeed.app/webregister',{text:'Product details\nOrder 12345\nOther notes'}),'');
});
