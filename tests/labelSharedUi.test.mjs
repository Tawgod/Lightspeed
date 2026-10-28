import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const server=readFileSync(new URL('../server.js',import.meta.url),'utf8');
const css=readFileSync(new URL('../shared-ui/hc.css',import.meta.url),'utf8');
const template=JSON.parse(readFileSync(new URL('../Templates/Avery_5960.json',import.meta.url),'utf8'));
test('DOM IDs and API contracts retained',()=>{
 for(const id of ['templateSelect','startRow','startCol','customText','loading','itemsTable','itemsBody','generateBtn']) assert.ok(html.includes('id="'+id+'"'),id);
 for(const endpoint of ['/api/templates','/api/po/','/api/labels/generate']) assert.ok(html.includes(endpoint),endpoint);
 assert.ok(html.includes('JSON.stringify({ poId, startRow, startCol, templateId, customText, items: itemsToPrint })'));
 for(const id of ['qty-','soQty-','custName-']) assert.ok(html.includes('id="'+id));
});
test('shared CSS and brand assets are reused',()=>{
 for(const value of ['class="hc-ui label-app"','/label-ui/hc.css','/label-ui/hc-wordmark.webp','class="hc-table"','role="status"']) assert.ok(html.includes(value),value);
 for(const value of ["app.get('/label-ui/hc.css'","app.get('/label-ui/hc-wordmark.webp'"]) assert.ok(server.includes(value),value);
 assert.ok(css.includes('.hc-ui .hc-panel'));
 assert.ok(css.includes('--hc-header:#102c48'));
});
test('Avery 5960 geometry, SKU barcode and PDF contract retained',()=>{
 assert.deepEqual(template.grid,{columns:3,rows:10,spacingX:198,spacingY:72});
 for(const value of ['const positionOnPage = labelCount % 30','const originX = 13.5 + (col * 198)','const originY = 36 + (row * 72)',"app.post('/api/labels/generate'","bcid: 'code128', text: item.sku"]) assert.ok(server.includes(value),value);
});
test('inline JS parses and retains source identifier strings',()=>{
 const match=html.match(/<script>([\s\S]*?)<\/script>/);
 assert.ok(match);
 assert.doesNotThrow(()=>new Script(match[1]));
 assert.ok(html.includes('item.sku'));
 assert.ok(html.includes("customerName: custNameInput ? custNameInput.value : ''"));
});
