// Scanner new-product proposal inbox. NEVER writes to Lightspeed or live preorder products.
import express from 'express';

const clean=(v,max=500)=>typeof v==='string'?v.trim().slice(0,max):'';
const validId=v=>Number.isSafeInteger(Number(v))&&Number(v)>0?Number(v):null;
const price=v=>{
  if(v===undefined||v===null||v==='')return null;
  const s=String(v).trim();
  if(!/^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/.test(s))throw Object.assign(new Error('Price must be a nonnegative amount with at most two decimal places.'),{status:400});
  return s;
};
function fields(body){
  if(!body||typeof body!=='object'||Array.isArray(body))throw Object.assign(new Error('Product details required.'),{status:400});
  const p={
    name:clean(body.name,250),sku:clean(body.sku,128),supplierSku:clean(body.supplierSku,128),
    upc:clean(body.upc,32).replace(/[^0-9]/g,''),description:clean(body.description,3000),
    brand:clean(body.brand,250),weight:clean(body.weight,80),
    imageUrl:clean(body.imageUrl,900),cost:price(body.cost),
    msrp:price(body.msrp),mapPrice:price(body.mapPrice)
  };
  if(!p.name || (!p.upc&&!p.sku&&!p.supplierSku))
    throw Object.assign(new Error('Product name and an identifying code are required.'),{status:400});
  if(p.upc&&![8,12,13,14].includes(p.upc.length))
    throw Object.assign(new Error('UPC/GTIN must be 8, 12, 13 or 14 digits.'),{status:400});
  if(p.imageUrl && !/^https:\/\//i.test(p.imageUrl))
    throw Object.assign(new Error('Product image must have an HTTPS URL.'),{status:400});
  return p;
}
function itemKey(p){
  // Prefer stable UPC, then supplier-specific reorder code, then general SKU.
  return p.upc?'upc:'+p.upc:p.supplierSku?'supplier:'+p.supplierSku.toUpperCase():'sku:'+p.sku.toUpperCase();
}
export async function initializeScannerProductReviewQueue(pool){
  await pool.query(`CREATE TABLE IF NOT EXISTS scanner_product_review_proposals (
    id BIGSERIAL PRIMARY KEY,
    supplier_id BIGINT NOT NULL REFERENCES suppliers(id),
    item_key TEXT NOT NULL,
    proposal_type TEXT NOT NULL DEFAULT 'NEW_PRODUCT' CHECK (proposal_type='NEW_PRODUCT'),
    status TEXT NOT NULL DEFAULT 'PENDING_REVIEW' CHECK(status IN ('PENDING_REVIEW','REJECTED')),
    product_payload JSONB NOT NULL,
    source_url TEXT NOT NULL,
    submitted_by BIGINT NOT NULL,
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    reviewed_by BIGINT,
    reviewed_at TIMESTAMPTZ,
    review_note TEXT,
    UNIQUE(supplier_id,item_key)
  )`);
}
export function createScannerProductReviewRouter({pool,verifyEmployee,lookup}={}){
  const router=express.Router();
  router.use(express.json({limit:'20kb'}));
  router.use((_req,res,next)=>{res.set('Cache-Control','no-store');next();});
  async function requireEmployee(req){
    if(typeof verifyEmployee!=='function')throw Object.assign(new Error('Employee verifier unavailable.'),{status:503});
    const e=await verifyEmployee(req);
    if(!e?.id||!e.canLookup)throw Object.assign(new Error('Active employee login required.'),{status:403});
    return e;
  }
  const failure=(res,e)=>res.status([400,401,403,409].includes(e.status)?e.status:503).json({error:e.status&&e.status<500?e.message:'Review queue unavailable.'});
  router.get('/product-proposals',async(req,res)=>{
    try{
      await requireEmployee(req);
      const result=await pool.query(`SELECT id,supplier_id,item_key,proposal_type,status,
          product_payload->>'name' AS product_name,submitted_at,submitted_by
          FROM scanner_product_review_proposals ORDER BY submitted_at DESC LIMIT 100`);
      res.json({proposals:result.rows});
    }catch(e){failure(res,e);}
  });
  router.get('/product-proposals/:id',async(req,res)=>{
    try{
      await requireEmployee(req);
      const id=validId(req.params.id);if(!id)return res.status(400).json({error:'Valid proposal required.'});
      const result=await pool.query(`SELECT id,supplier_id,item_key,proposal_type,status,
         product_payload,source_url,submitted_by,submitted_at,reviewed_by,reviewed_at,review_note
         FROM scanner_product_review_proposals WHERE id=$1`,[id]);
      if(!result.rows.length)return res.status(404).json({error:'Proposal not found.'});
      res.json({proposal:result.rows[0]});
    }catch(e){failure(res,e);}
  });
  router.post('/product-proposals',async(req,res)=>{
    try{
      const employee=await requireEmployee(req);
      if(typeof lookup!=='function')throw Object.assign(new Error('Duplicate verification unavailable.'),{status:503});
      const supplierId=validId(req.body?.supplierId);
      if(!supplierId)throw Object.assign(new Error('Verified supplier required.'),{status:400});
      const sourceUrl=clean(req.body?.sourceUrl,1000);
      let parsed;
      try{parsed=new URL(sourceUrl);}catch{throw Object.assign(new Error('Individual supplier product URL required.'),{status:400});}
      if(parsed.protocol!=='https:'||parsed.username||parsed.password)
        throw Object.assign(new Error('Secure supplier product URL required.'),{status:400});
      const p=fields(req.body?.product);
      // Server-side recheck is mandatory; browser verification is not trusted.
      // Do NOT use supplier_id as a match filter: find cross-supplier duplicates.
      const payload={product_code:p.upc||p.sku,sku:p.sku,supplier_sku:p.supplierSku,name:p.name,description:p.description};
      const [local,remote]=await Promise.all([lookup('local',payload,employee),lookup('remote',payload,employee)]);
      if(!Array.isArray(local?.matches)||!Array.isArray(remote?.matches))
        throw Object.assign(new Error('Duplicate check incomplete.'),{status:503});
      if(local.matches.length||remote.matches.length)
        return res.status(409).json({error:'Potential existing product found. Review the match instead of requesting new product creation.'});
      const inserted=await pool.query(`INSERT INTO scanner_product_review_proposals
        (supplier_id,item_key,product_payload,source_url,submitted_by)
        SELECT $1,$2,$3::jsonb,$4,$5 WHERE EXISTS
          (SELECT 1 FROM suppliers WHERE id=$1 AND is_active=TRUE)
        ON CONFLICT (supplier_id,item_key) DO NOTHING
        RETURNING id,status,submitted_at`,[supplierId,itemKey(p),JSON.stringify(p),sourceUrl,employee.id]);
      if(!inserted.rows.length)
        return res.status(409).json({error:'A proposal for this product already exists, or supplier is inactive.'});
      return res.status(201).json({proposal:{...inserted.rows[0],productName:p.name}});
    }catch(e){failure(res,e);}
  });
  // Intentionally no approve, create, update, delete, or Discord endpoint.
  // Such actions require a separate permissions decision and duplicate-safe write plan.
  return router;
}
