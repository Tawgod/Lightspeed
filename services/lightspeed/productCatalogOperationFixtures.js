// Offline operation-check scenario, never a writer or Security implementation.
// Operation labels are proposals pending the Security-owned registry.
// No execution callback, transport, storage, token, or production mode.
import {randomUUID} from 'node:crypto';
const tools=new Set(['ProductManager','Scanner','SpecialOrders','Purchasing','Consignment','Preorders','Repairs','RMSImport','Automation']);
const channels=new Set(['direct','api','bulk','import','indirect','automation']);
const fields=new Set(['name','sku','upc','supplierSku','supplierId','categoryId','retail','msrp','cost']);
const exact=v=>typeof v==='string'&&v.length>0&&v.length<=256&&v.trim()===v&&!/[\x00-\x1f\x7f]/.test(v);
const denied=()=>({state:'denied',executable:false});
const validTarget=t=>t&&exact(t.productId)&&(t.variantId===null||exact(t.variantId));

// Each entry is a trusted server-side synthetic scenario, NOT client input.
// Future owners must map all actual routes to canonical effects, not trust
// a caller's tool name, action label, changed fields or permission assertions.
export async function inspectCatalogOperationScenario({authorize,context,scenario}={}) {
 if(typeof authorize!=='function'||!scenario||!tools.has(scenario.tool)||!channels.has(scenario.channel)||
    !['create','update'].includes(scenario.effect)||!['propose','approve','execute'].includes(scenario.phase)||
    !Array.isArray(scenario.changes)||!scenario.changes.length)return denied();
 const requests=[];
 for(const change of scenario.changes){
   if(!validTarget(change?.target)||!Array.isArray(change.fields)||!change.fields.length||
      change.fields.some(f=>!fields.has(f))||new Set(change.fields).size!==change.fields.length)return denied();
   const resource={productId:change.target.productId,variantId:change.target.variantId};
   const fieldList=[...change.fields].sort();
   const operation='catalog.product.'+scenario.effect;
   requests.push({operation,resource,fields:fieldList});
   if(fieldList.includes('cost'))requests.push({operation:'catalog.product.cost.modify',resource,fields:['cost']});
   if(scenario.phase!=='propose')requests.push({operation:operation+'.'+scenario.phase,resource,fields:fieldList});
 }
 const correlationId=randomUUID();
 for(const request of requests){
   try{
     if(await authorize({...request,context,environment:'test',mode:scenario.phase,correlationId})!==true)return denied();
   }catch{return denied();}
 }
 return {state:'fixture_checks_passed',executable:false,correlationId};
}
