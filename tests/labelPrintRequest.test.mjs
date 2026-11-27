import test from 'node:test';
import assert from 'node:assert/strict';
import {buildLabelPrintRequest as build} from '../Templates/label-print-request.mjs';
const item={sku:'0000123',name:'Sample <kit>',price:'$4.99',qty:2};
test('selected products use existing PDF payload and exact SKU',()=>{
 assert.deepEqual(build({items:[{...item,internalId:'not forwarded'}]}),{poId:'SELECTED_PRODUCTS',startRow:1,startCol:1,templateId:'Avery_5960',customText:'',items:[{...item,soQty:0,customerName:''}]});
});
test('partial sheets, special orders and skips',()=>{
 const r=build({sourceId:'PO_123',startRow:10,startCol:3,items:[{...item,qty:0},{...item,soQty:1,customerName:'Sample Customer'}]});
 assert.equal(r.items.length,1);assert.equal(r.items[0].soQty,1);assert.equal(r.startRow,10);assert.equal(r.startCol,3);
});
test('invalid input never becomes a printable request',()=>{
 for(const patch of [{sku:123},{sku:'UNKNOWN'},{price:''},{price:4.99},{qty:-1},{qty:1.5},{soQty:3},{soQty:1},{name:''}])assert.throws(()=>build({items:[{...item,...patch}]}),TypeError);
 for(const patch of [{startRow:11},{startCol:0},{templateId:'../other'},{sourceId:'a/b'},{items:[]},{items:[{...item,qty:501},{...item,qty:501}]}])assert.throws(()=>build({items:[item],...patch}),TypeError);
});
