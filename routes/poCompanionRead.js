import express from 'express';

const idOk=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(value);
const rows=data=>Array.isArray(data?.data)?data.data:Array.isArray(data)?data:null;
const safeString=x=>x==null?'':String(x);
export function createPoCompanionReadRouter({verifyEmployee,readLightspeed,pool}={}){
 const router=express.Router();
 router.get('/purchase-orders/:id',async(req,res)=>{
  res.set('Cache-Control','no-store');
  try{
   if(typeof verifyEmployee!=='function'||typeof readLightspeed!=='function'||!pool)return res.status(503).json({error:'PO lookup not configured.'});
   const employee=await verifyEmployee(req);
   if(!employee?.id||!employee.canLookup)return res.status(403).json({error:'Employee PO lookup not allowed.'});
   const id=req.params.id;
   if(!idOk(id))return res.status(400).json({error:'Invalid purchase order ID.'});
   // Use the same current 2026-04 endpoints as Ordering; no product/order writes.
   const listed=rows(await readLightspeed('/purchase_orders?page_size=1000'));
   if(!listed)return res.status(502).json({error:'Unrecognized purchase order response.'});
   const po=listed.find(p=>safeString(p?.id)===id);
   if(!po)return res.status(404).json({error:'Purchase order not found in current Lightspeed list.'});
   const lineResponse=rows(await readLightspeed('/purchase_orders/'+encodeURIComponent(id)+'/line_items?page_size=1000'));
   if(!lineResponse)return res.status(502).json({error:'Unrecognized PO line response.'});
   const supplierLS=safeString(po.supplier_id||po.supplier?.id);
   let supplier=null;
   if(supplierLS){
    const s=await pool.query('SELECT id,name FROM suppliers WHERE lightspeed_supplier_id=$1 AND is_active=true LIMIT 2',[supplierLS]);
    if(s.rows.length===1)supplier=s.rows[0];
   }
   const productIds=[...new Set(lineResponse.map(x=>safeString(x.product_id||x.product?.id||x.product?.product_id)).filter(Boolean))];
   const mapped=new Map();
   if(productIds.length&&supplier?.id){
    const q=await pool.query(`SELECT p.lightspeed_product_id,p.name,p.upc,p.sku,sp.supplier_sku,sp.supply_price,sp.is_orderable,sp.availability_status
     FROM products p LEFT JOIN supplier_products sp ON sp.product_id=p.id AND sp.supplier_id=$2
     WHERE p.lightspeed_product_id=ANY($1::text[])`,[productIds,supplier.id]);
    for(const item of q.rows){const key=safeString(item.lightspeed_product_id);if(mapped.has(key))mapped.set(key,null);else mapped.set(key,item);}
   }
   const items=lineResponse.map((line,index)=>{
    const productId=safeString(line.product_id||line.product?.id||line.product?.product_id);
    const match=mapped.get(productId);
    const warnings=[];
    if(!supplier)warnings.push('SUPPLIER_UNRESOLVED');
    if(!productId)warnings.push('MISSING_PRODUCT_ID');
    if(productId&&supplier&&!match)warnings.push('PRODUCT_OR_MAPPING_UNRESOLVED');
    if(match&&!match.supplier_sku)warnings.push('MISSING_SUPPLIER_SKU');
    if(match?.is_orderable===false)warnings.push('NOT_ORDERABLE');
    const qty=Number(line.quantity??line.quantity_ordered??line.count??0);
    return {lineId:safeString(line.id||'line-'+index+'-'+productId),lightspeedProductId:productId,
     name:safeString(line.product?.name||line.name||match?.name||'Unnamed product'),
     quantity:Number.isFinite(qty)?qty:0,
     supplierSku:safeString(match?.supplier_sku),upc:safeString(match?.upc||line.product?.upc||line.upc),
     sku:safeString(match?.sku||line.product?.sku||line.sku),warnings,
     original:{supplierCost:match?.supply_price==null?null:safeString(match.supply_price)}};
   });
   res.json({readOnly:true,purchaseOrder:{id,supplier:{localId:supplier?.id||null,lightspeedId:supplierLS||null,name:supplier?.name||po.supplier?.name||null},status:po.status||null},items});
  }catch(e){const status=[400,401,403,404].includes(e.status)?e.status:502;res.status(status).json({error:status===502?'Authenticated PO lookup unavailable.':e.message});}
 });
 return router;
}
