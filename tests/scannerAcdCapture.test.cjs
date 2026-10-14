const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

// Test the single page capture function used by both scanner windows.
const source=fs.readFileSync('extension/product-scanner/page-capture.js','utf8');
const functionSource='('+source.replace('export function captureSupplierProductPage()', 'function()')+')';
function capture(text,{host='www.acdd.com',jsonLd=[]}={}){
  const tags={};
  const document={
    body:{innerText:text},
    title:'Mechs vs. Minions: Bandle City Edition',
    querySelector(selector){
      if(selector.startsWith('meta'))return null;
      return null;
    },
    querySelectorAll(selector){
      if(selector==='script[type="application/ld+json"]')
        return jsonLd.map(value=>({textContent:JSON.stringify(value)}));
      return [];
    }
  };
  const fn=vm.runInNewContext(functionSource,{document,location:{hostname:host,href:'https://www.acdd.com/products/example'},Date,JSON,Array,String,RegExp});
  return fn().product;
}
test('ACD visible product detail labels populate supplier fields, even without JSON-LD',()=>{
 const result=capture([
   'Mechs vs. Minions: Bandle City Edition',
   'Additional details',
   'SKU: IDRAYA4102100EN      MSRP: $74.99',
   'Manufacturer: Incredible Dream     Category: Preorder',
   'UPC: 850052382605          Order By Date: Oct 26, 2026',
   '$41.24','Quantity:'
 ].join('\n'));
 assert.equal(result.supplierSku,'IDRAYA4102100EN');
 assert.equal(result.sku,'');
 assert.equal(result.upc,'850052382605');
 assert.equal(result.brand,'Incredible Dream');
 assert.equal(result.msrp,'74.99');
 assert.equal(result.cost,'41.24');
 assert.equal(result.availabilityNote,'Preorder');
 assert.equal(result.supplierName,'ACD Distribution');
});
test('ACD extracts optional weight and preserves units',()=>{
 const result=capture('SKU: IDRAYA4102100EN\nUPC: 850052382605\nWeight: 4.5 lbs\nMSRP: $74.99');
 assert.equal(result.weight,'4.5 lbs');
});
test('ACD UPC fallback does not use nonnumeric identifiers',()=>{
 const result=capture('SKU: IDRAYA4102100EN\nUPC: Unknown\nMSRP: $74.99');
 assert.equal(result.upc,'');
});
test('Visible ACD labels cannot override other supplier pages',()=>{
 const result=capture('SKU: IDRAYA4102100EN\nUPC: 850052382605',{host:'supplier.example.com'});
 assert.equal(result.supplierSku,'');
 assert.equal(result.upc,'');
});
test('Structured GTIN continues working independently of ACD labels',()=>{
 const result=capture('',{host:'supplier.example.com',jsonLd:[{'@type':'Product',name:'Sample',sku:'SUP-1',gtin12:'850052382605'}]});
 assert.equal(result.upc,'850052382605');
 assert.equal(result.supplierSku,'SUP-1');
});
