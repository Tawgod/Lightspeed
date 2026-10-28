import test from "node:test";
import assert from "node:assert/strict";
import {validateField,previewChanges,findIdentifierConflicts,committedFromReservations,normalizeCategoryPath} from "./validation.js";
test("Money and maximum quantity validation",()=>{
 assert.equal(validateField("price","12.50"),null);
 assert.match(validateField("price","12.555"),/currency/i);
 assert.match(validateField("maxQty",0),/minimum/i);
 assert.equal(validateField("maxQty",2),null);
 assert.match(validateField("committed",5),/cannot be edited/i);
});
test("Review blocks stale and unknown fields, never submits",()=>{
 const p=[{id:"p1",sku:"ITEM-1",name:"Old",price:12}];
 const result=previewChanges(p,[
  {productId:"p1",field:"name",oldValue:"Old",newValue:"New"},
  {productId:"p1",field:"price",oldValue:10,newValue:15},
  {productId:"p1",field:"madeUp",oldValue:1,newValue:2}
 ]);
 assert.equal(result.entries.length,1);
 assert.equal(result.errors.length,2);
 assert.equal(result.canSubmit,false);
});
test("SKU/UPC conflict detection uses normalized exact identifiers",()=>{
 assert.equal(findIdentifierConflicts([{id:1,sku:" AbC ",upc:"123"}],{sku:"abc"}).length,1);
});
test("Committed quantity de-duplicates and excludes fulfilled/void",()=>{
 const r=[{source:"SO",id:"1",productId:"p",status:"HELD",quantity:3,fulfilled:1},
 {source:"SO",id:"1",productId:"p",status:"HELD",quantity:3,fulfilled:1},
 {source:"SO",id:"2",productId:"p",status:"CANCELLED",quantity:5},
 {source:"LS",id:"3",productId:"p",status:"READY",quantity:2}];
 assert.equal(committedFromReservations(r,"p"),4);
});
test("Category path retains up to three levels",()=>{
 assert.deepEqual(normalizeCategoryPath("Games / Card Games / Sleeves"),["Games","Card Games","Sleeves"]);
});
