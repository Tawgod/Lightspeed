import express from 'express';

// Read-only PO retrieval. The supplier must match the PO's Lightspeed supplier ID
// before any supplier-specific code or supply cost can be displayed.
export function createPoCompanionRouter({verifyEmployee,lightspeed,pool}={}){
 const router=express.Router();
 router.get('/purchase-orders/:poId',async(req,res)=>{
  res.set('Cache-Control','no-store');
  try{
   const employee=await verifyEmployee(req);
   if(!employee?.canLookup) return res.status(403).json({error:'Employee lookup access required.'});
   const poId=String(req.params.poId||'');
   if(!/^[a-z0-9_-]{1,100}$/i.test(poId))return res.status(400).json({error:'Invalid PO identifier.'});
   const [header,linesResponse]=await Promise.all([lightspeed.getConsignment(poId),lightspeed.getConsignmentProducts(poId)]);
   const po=header?.data||header;
   const raw=linesResponse?.data;
   if(!po || !Array.isArray(raw))return res.status(502).json({error:'Invalid Lightspeed PO response.'});
   const supplierLsId=String(po.supplier_id||po.supplier?.id||'');
   let supplier=null;
   if(supplierLsId){
    const query=await pool.query('SELECT id,name,lightspeed_supplier_id FROM suppliers WHERE lightspeed_supplier_id=$1 LIMIT 2',[supplierLsId]);
    if(query.rows.length===1)supplier=query.rows[0];
   }
   const ids=raw.map(x=>String(x.product_id||x.product?.id||'')).filter(Boolean);
   const mapped=new Map();
   if(ids.length){
    const query=await pool.query(`
     SELECT p.lightspeed_product_id, sp.id AS supplier_product_id,
       sp.supplier_sku, sp.supply_price, sp.availability_status, sp.is_orderable
     FROM products p
     LEFT JOIN supplier_products sp ON sp.product_id=p.id AND sp.supplier_id=$2::bigint
     WHERE p.lightspeed_product_id=ANY($1::text[])
    `,[ids,supplier?.id||null]);
    for(const row of query.rows)mapped.set(String(row.lightspeed_product_id),row);
   }
   const items=raw.map((line,index)=>{
    const productId=String(line.product_id||line.product?.id||'');
    const match=mapped.get(productId);
    const upc=String(line.product?.upc||line.upc||'');
    const warnings=[];
    if(!supplier)warnings.push('SUPPLIER_NOT_MAPPED');
    if(!productId)warnings.push('MISSING_PRODUCT_ID');
    if(productId&&!match)warnings.push('PRODUCT_NOT_MAPPED');
    if(supplier&&!match?.supplier_product_id)warnings.push('SUPPLIER_PRODUCT_NOT_MAPPED');
    if(supplier&&!match?.supplier_sku)warnings.push('MISSING_SUPPLIER_SKU');
    if(match?.is_orderable===false)warnings.push('NOT_ORDERABLE');
    if(match?.availability_status && !/^(available|in.stock|in_stock)$/i.test(match.availability_status))warnings.push('CHECK_AVAILABILITY');
    const quantity=Number(line.quantity||line.count||line.quantity_ordered||0);
    return {
     lineId:String(line.id||('index-'+index+'-'+productId)),lightspeedProductId:productId,
     name:String(line.product?.name||line.name||line.product_name||'(Unnamed product)'),
     quantity:Number.isFinite(quantity)?quantity:0,
     sku:String(line.product?.sku||line.sku||''),
     upc,supplierSku:supplier?String(match?.supplier_sku||''):'',
     supplierCost:supplier&&match?.supply_price!=null?String(match.supply_price):null,
     // Reorder and MSRP omitted until individually verified against Lightspeed.
     reorderPoint:null,reorderQuantity:null,msrp:null,
     warnings
    };
   });
   res.json({readOnly:true,purchaseOrder:{id:poId,status:po.status||null,supplier:{
     lightspeedId:supplierLsId||null,localId:supplier?.id||null,name:supplier?.name||po.supplier?.name||null
   }},items});
  }catch(error){
   const status=[400,401,403,404].includes(error.status)?error.status:502;
   res.status(status).json({error:status===502?'PO lookup unavailable. Check credentials, supplier mapping, and Lightspeed response.':error.message});
  }
 });
 return router;
}
