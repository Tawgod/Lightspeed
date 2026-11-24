import test from 'node:test';
import assert from 'node:assert/strict';
import { createLightspeedPurchaseOrdersRead, normalizeLightspeedPurchaseOrder } from '../services/lightspeed/purchaseOrders.js';
import { createPurchasingRead, projectPurchaseOrder, projectInvoiceLineEvidence, projectShipmentEvidence } from '../services/lightspeed/purchaseOrderProjection.js';
const base='/api/2026-04/purchase_orders';
const po={id:'PO01',supplier_id:'0001',outlet_id:'O1',status:'OPEN',type:'SUPPLIER'};
const line={id:'L01',product_id:'P1',quantity_ordered:'4',supplier_sku:'0000123',upc:'0000012345678',sku:'001'};
const now='2026-11-24T15:00:00.000Z';
function fixture(responses){
 const calls=[];
 const transport={async request(path){calls.push(path);assert.ok(Object.hasOwn(responses,path),path);const value=responses[path];if(value instanceof Error)throw value;return value;}};
 const legacy=createLightspeedPurchaseOrdersRead({transport});
 return {calls,legacy,read:createPurchasingRead({purchaseOrders:legacy,clock:()=>new Date(now)})};
}
const project=(p=po,lines=[line])=>projectPurchaseOrder(normalizeLightspeedPurchaseOrder(p,lines),now);
test('shared reader follows both list and line cursors; exact identifiers survive',async()=>{
 const f=fixture({[base+'?page_size=1000']:{data:[{...po,id:'OTHER'}],version:{max:1}},[base+'?page_size=1000&after=1']:{data:[po],version:{max:2}},[base+'?page_size=1000&after=2']:{data:[]},[base+'/PO01/line_items?page_size=1000']:{data:[line],version:{max:3}},[base+'/PO01/line_items?page_size=1000&after=3']:{data:[{...line,id:'L02'}],version:{max:4}},[base+'/PO01/line_items?page_size=1000&after=4']:{data:[]}});
 const p=await f.read.get('PO01');assert.equal(p.lines.length,2);assert.equal(p.lines[0].supplierSku,'0000123');assert.equal(p.lines[0].upc,'0000012345678');assert.equal(p.lines[0].sku,'001');assert.equal(p.supplier.id,'0001');assert.equal(p.source.readAt,now);assert.equal(p.source.snapshotAtomic,false);assert.equal(f.calls.length,6);assert.deepEqual(Object.keys(f.read).sort(),['get','list']);
});
test('incomplete line pagination rejects rather than returning partial PO',async()=>{
 const f=fixture({[base+'?page_size=1000']:{data:[po]},[base+'/PO01/line_items?page_size=1000']:{data:[line],pagination:{has_next:true}}});
 await assert.rejects(f.read.get('PO01'),{code:'LIGHTSPEED_INCOMPLETE_READ'});
});
test('duplicate PO list and line identities fail closed',async()=>{
 const f=fixture({[base+'?page_size=1000']:{data:[po,po]}});
 await assert.rejects(f.read.list(),{code:'LIGHTSPEED_INCOMPLETE_READ'});
 assert.throws(()=>project(po,[line,line]),{code:'LIGHTSPEED_INCOMPLETE_READ'});
});
test('missing line identity not fabricated; product supplier code not promoted',()=>{
 const p=project(po,[{product:{id:'P1',supplier_code:'0008'}}]);
 assert.equal(p.lines[0].id,null);assert.equal(p.lines[0].supplierSku,null);assert.equal(p.lines[0].orderedQty,null);assert.ok(p.lines[0].warnings.includes('missing_line_id'));
});
test('conflicting supplier and product identities and numeric SKU rejected',()=>{
 for(const run of [()=>project({...po,supplier:{id:'S2'}}),()=>project(po,[{...line,product:{id:'P2'}}]),()=>project(po,[{...line,sku:123}]),()=>project(po,[{...line,supplier_code:'OTHER'}])])assert.throws(run,{code:'LIGHTSPEED_INCOMPLETE_READ'});
});
test('Ordering quantity aliases, zero and conflicts stay distinct',()=>{
 for(const field of ['quantity','quantity_ordered','count','ordered_quantity','order_quantity'])assert.equal(project(po,[{id:'L',[field]:'4'}]).lines[0].orderedQty,4);
 assert.equal(project(po,[{id:'L',quantity:0}]).lines[0].orderedQty,0);
 for(const value of [true,' ', -1,'0x10',null])assert.equal(project(po,[{id:'L',quantity:value}]).lines[0].orderedQty,null);
 assert.equal(project(po,[{id:'L',quantity:2,ordered_quantity:3}]).lines[0].orderedQty,null);
});
test('filter matches exact supplier and reports unresolved references',async()=>{
 const f=fixture({[base+'?page_size=1000']:{data:[po,{id:'PO2',status:'OPEN'},{...po,id:'PO3',supplier_id:'1'}]}});
 const p=await f.read.list({supplierId:'0001',status:'OPEN'});assert.deepEqual(p.items.map(x=>x.id),['PO01']);assert.equal(p.unresolvedReferenceCount,1);
 await assert.rejects(f.read.list({cursor:'1'}),TypeError);
});
test('vendor status never establishes receipt; unknown stays unknown',()=>{
 for(const status of ['OPEN','RECEIVED','DISPATCHED','unexpected']){const p=project({...po,status,received_quantity:50},[{...line,received_quantity:4}]);assert.equal(p.receiving.state,'UNKNOWN');assert.equal(p.receiving.receivedQty,null);assert.equal(p.purchasingStatus,status==='unexpected'?'UNKNOWN':status);assert.equal(Object.hasOwn(p.lines[0],'received_quantity'),false);}
});
test('invoice and shipment evidence strips received, stock, allocation and approval commands',()=>{
 const hostile={invoiceId:'I1',lineId:'L1',supplierId:'0001',trackingId:'00002',documentRef:'D1',invoicedQty:'5',receivedQty:5,status:'RECEIVED',inventoryDelta:5,ready:true,approved:true,allocate:()=>assert.fail()};
 assert.deepEqual(projectInvoiceLineEvidence(hostile),{invoiceId:'I1',lineId:'L1',supplierId:'0001',invoicedQty:5,documentRef:'D1',evidenceOnly:true});
 assert.deepEqual(projectShipmentEvidence(hostile),{supplierId:'0001',trackingId:'00002',carrier:null,documentRef:'D1',evidenceOnly:true});
});
test('legacy PO Companion injection shape and raw fields preserved',async()=>{
 const f=fixture({[base+'?page_size=1000']:{data:[po]},[base+'/PO01/line_items?page_size=1000']:{data:[{...line,supply_price:'3.25'}]}});
 const p=await f.legacy.get('PO01');assert.equal(p.status,'OPEN');assert.equal(p.lines[0].quantity,4);assert.equal(p.lines[0].raw.supply_price,'3.25');assert.equal(p.lines[0].supplierSku,'0000123');
});
