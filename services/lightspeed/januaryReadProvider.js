// Internal unmounted provider evidence, not an authorization or public response.
import {createLightspeedProductsRead} from './products.js';
import {createLightspeedInventoryRead} from './inventory.js';
import {readLightspeedCollection} from './readCollection.js';
export function createJanuaryReadProvider({products,inventory,collection,scope,clock=Date.now}={}){
 const text=v=>typeof v==='string'&&v.length<=256&&v.trim().length>0&&!/[\u0000-\u001f\u007f]/u.test(v);
 const keys=['tenant','environment','location','sourceRef'];
 if(!keys.every(k=>text(scope?.[k]))||typeof products?.get!=='function'||typeof inventory?.byProduct!=='function'||typeof collection!=='function'||typeof clock!=='function')throw new TypeError('Trusted read dependencies and scope required');
 const bound=Object.freeze(Object.fromEntries(keys.map(k=>[k,scope[k]])));
 const get=products.get.bind(products),stock=inventory.byProduct.bind(inventory);
 const result=(status,kind,id,data=null)=>({status,kind,scope:{...bound},providerId:id,observedAt:status==='OBSERVED'?clock():null,data});
 const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&Object.getPrototypeOf(x)===Object.prototype;
 const copy=x=>JSON.parse(JSON.stringify(x));
 const safeId=id=>{if(!text(id))throw new TypeError('Exact provider ID required');};
 async function product(id){
  safeId(id);
  try{const body=await get(id);const row=object(body)&&Object.hasOwn(body,'data')?body.data:body;
   return object(row)&&row.id===id?result('OBSERVED','product',id,copy(row)):result('INCOMPLETE','product',id);
  }catch{return result('UNAVAILABLE','product',id);}
 }
 async function quantities(id){
  safeId(id);
  try{const data=await stock(id);
   return (object(data)||Array.isArray(data))?result('OBSERVED','inventory',id,copy(data)):result('INCOMPLETE','inventory',id);
  }catch{return result('UNAVAILABLE','inventory',id);}
 }
 async function catalog(){
  try{const rows=await collection();
   if(!Array.isArray(rows)||rows.some(r=>!object(r)||!text(r.id))||new Set(rows.map(r=>r.id)).size!==rows.length)return result('INCOMPLETE','catalog',null);
   return {...result('OBSERVED','catalog',null,copy(rows)),traversalFinished:true,namespaceCoverageVerified:false};
  }catch{return result('UNAVAILABLE','catalog',null);}
 }
 return Object.freeze({product,quantities,catalog});
}
export function createV10JanuaryReadProvider({transport,scope,clock,maxPages=20,maxRows=20000}={}){
 const products=createLightspeedProductsRead({transport});
 const inventory=createLightspeedInventoryRead({transport});
 const collection=()=>readLightspeedCollection({transport,path:'/api/2026-07/products?page_size=1000',pagination:'version',maxPages,maxRows});
 return createJanuaryReadProvider({products,inventory,collection,scope,clock});
}
