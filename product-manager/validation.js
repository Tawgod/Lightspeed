// Product Manager foundation — no Lightspeed write operations.
// A single source of truth for read-only field capabilities and draft validation.
export const FIELDS = Object.freeze({
  name:{source:"X",type:"text",required:true},
  sku:{source:"X",type:"text",required:true},
  upc:{source:"X",type:"text"},
  category:{source:"X",type:"text"},
  cost:{source:"X",type:"money",min:0},
  price:{source:"X",type:"money",min:0},
  itemOnline:{source:"X",type:"boolean"},
  tags:{source:"X",type:"text"},
  description:{source:"X",type:"text"},
  maxQty:{source:"E",type:"integer",min:1,nullable:true},
  seoTitle:{source:"E",type:"text"},
  compareAtPrice:{source:"E",type:"money",min:0},
  notes:{source:"HC",type:"text"},
  committed:{source:"CALCULATED",type:"integer",readonly:true},
  available:{source:"CALCULATED",type:"integer",readonly:true}
});
const key = v => String(v??"").trim().toUpperCase();
export function validateField(field,value){
  const def=FIELDS[field];
  if(!def)return "Unknown field";
  if(def.readonly)return "Calculated field cannot be edited";
  if(value===null || value===""){
    return def.required?"Required field":def.nullable?null:"Blank value not permitted";
  }
  if(def.type==="boolean" && typeof value!=="boolean")return "Expected true or false";
  if(def.type==="integer" && (!Number.isSafeInteger(Number(value)) || !String(value).trim()))return "Expected whole number";
  if(def.type==="money" && (!Number.isFinite(Number(value)) || !/^-?\d+(?:\.\d{1,2})?$/.test(String(value))))return "Expected currency with up to two decimal places";
  if((def.type==="money"||def.type==="integer") && def.min!==undefined && Number(value)<def.min)return "Below allowed minimum";
  if(def.type==="text" && typeof value!=="string")return "Expected text";
  return null;
}
export function previewChanges(products,updates){
  const byId=new Map(products.map(p=>[String(p.id),p]));
  const entries=[], errors=[];
  for(const [index,change] of updates.entries()){
    const product=byId.get(String(change.productId));
    if(!product){errors.push({index,error:"Product not found"});continue}
    const validation=validateField(change.field,change.newValue);
    if(validation){errors.push({index,error:validation});continue}
    // Prevent silently overwriting another employee's changes.
    if(!Object.is(product[change.field],change.oldValue)){
      errors.push({index,error:"Stale value — reload and review"});continue;
    }
    if(Object.is(change.oldValue,change.newValue))continue;
    entries.push({productId:product.id,sku:product.sku,field:change.field,
      source:FIELDS[change.field].source,oldValue:change.oldValue,newValue:change.newValue});
  }
  return {entries,errors,canSubmit:false,mode:"PREVIEW_ONLY"};
}
export function findIdentifierConflicts(products,candidate){
  const sku=key(candidate.sku),upc=key(candidate.upc);
  return products.filter(p=>(sku&&key(p.sku)===sku)||(upc&&key(p.upc)===upc))
    .map(p=>({id:p.id,sku:p.sku,reason:sku&&key(p.sku)===sku?"SKU":"UPC"}));
}
export function committedFromReservations(reservations,productId){
  // Aggregated outstanding reservations must be fed from authoritative SO/hold data.
  // Never sum completed/cancelled reservations; de-duplicate source + reservation ID.
  const seen=new Set();let count=0;
  for(const r of reservations){
    if(String(r.productId)!==String(productId))continue;
    if(!["HELD","READY","RESERVED"].includes(String(r.status).toUpperCase()))continue;
    const id=String(r.source||"unknown")+":"+String(r.id||"");
    if(!r.id||seen.has(id))continue;
    seen.add(id);
    const outstanding=Number(r.quantity)-Number(r.fulfilled||0);
    if(Number.isFinite(outstanding))count+=Math.max(0,outstanding);
  }
  return count;
}
export function normalizeCategoryPath(value){
  return String(value||"").split("/").map(v=>v.trim()).filter(Boolean).slice(0,3);
}
