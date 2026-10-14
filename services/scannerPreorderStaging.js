// Authenticated scanner queue for campaign-bound product proposals.
// Separate from preorder_products so Discord publishing cannot pick up unreviewed items.
import express from 'express';
export async function initializeScannerPreorderStaging(pool){
  await pool.query(`CREATE TABLE IF NOT EXISTS scanner_preorder_staged_items(
    id BIGSERIAL PRIMARY KEY,
    campaign_id BIGINT NOT NULL REFERENCES preorder_campaigns(id) ON DELETE RESTRICT,
    supplier_id BIGINT REFERENCES suppliers(id),
    item_key TEXT NOT NULL,
    item_name TEXT NOT NULL,
    sku TEXT,
    supplier_sku TEXT,
    upc TEXT,
    description TEXT,
    cost NUMERIC(12,2),
    msrp NUMERIC(12,2),
    map_price NUMERIC(12,2),
    weight_text TEXT,
    image_url TEXT,
    source_url TEXT,
    status TEXT NOT NULL DEFAULT 'PENDING_REVIEW' CHECK(status IN ('PENDING_REVIEW','APPROVED','REJECTED')),
    staged_by BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(campaign_id,item_key)
  )`);
}
function clean(v,max=500){return typeof v==='string'?v.trim().slice(0,max):'';}
function money(v){
  if(v==null||v==='')return null;
  const s=String(v).trim();
  if(!/^[0-9]{1,8}(?:\.[0-9]{1,2})?$/.test(s))throw Object.assign(new Error('Invalid price field.'),{status:400});
  return s;
}
function validId(v){const n=Number(v);return Number.isSafeInteger(n)&&n>0?n:null;}
function itemKey(p){
  const upc=clean(p.upc,18).replace(/\D/g,'');
  if([8,12,13,14].includes(upc.length))return 'upc:'+upc;
  const supplierSku=clean(p.supplierSku,128).toUpperCase();
  if(supplierSku)return 'supplier:'+supplierSku;
  const sku=clean(p.sku,128).toUpperCase();
  if(sku)return 'sku:'+sku;
  // Unidentified items cannot be safely deduplicated across repeated scans.
  throw Object.assign(new Error('UPC or SKU is required to stage a preorder item.'),{status:400});
}
export function createScannerPreorderRouter({pool,verifyEmployee}={}){
  const router=express.Router();
  router.use(express.json({limit:'16kb'}));
  router.use((_req,res,next)=>{res.set('Cache-Control','no-store');next();});
  const fail=(res,e)=>res.status([400,401,403,404,409].includes(e?.status)?e.status:503).json({error:e?.status&&e.status<500?e.message:'Preorder staging unavailable.'});
  async function authorized(req,approve=false){
    if(typeof verifyEmployee!=='function')throw Object.assign(new Error('Authorization unavailable'),{status:503});
    const e=await verifyEmployee(req);
    if(!e?.id||!e.canLookup)throw Object.assign(new Error('Scanner login required'),{status:401});
    if(approve&&!e.canApprove)throw Object.assign(new Error('Manager or Admin approval required to stage preorder items.'),{status:403});
    return e;
  }
  router.get('/preorder-campaigns',async(req,res)=>{
    try{
      await authorized(req);
      const result=await pool.query(`SELECT id,name,status,campaign_type,order_due_at
        FROM preorder_campaigns WHERE UPPER(COALESCE(status,'')) NOT IN ('CANCELLED','CLOSED','COMPLETE','COMPLETED','ARCHIVED')
        ORDER BY order_due_at NULLS LAST, name LIMIT 150`);
      res.json({campaigns:result.rows});
    }catch(e){fail(res,e);}
  });
  router.get('/preorder-campaigns/:id/staged',async(req,res)=>{
    try{
      await authorized(req);
      const id=validId(req.params.id);if(!id)return res.status(400).json({error:'Valid campaign required.'});
      const r=await pool.query(`SELECT item_name,sku,supplier_sku,upc,status,created_at
        FROM scanner_preorder_staged_items WHERE campaign_id=$1 ORDER BY created_at DESC LIMIT 150`,[id]);
      res.json({items:r.rows});
    }catch(e){fail(res,e);}
  });
  router.post('/preorder-campaigns/:id/staged',async(req,res)=>{
    try{
      const e=await authorized(req,true);
      const campaignId=validId(req.params.id),supplierId=validId(req.body?.supplierId);
      if(!campaignId||!supplierId)throw Object.assign(new Error('Verified campaign and supplier required.'),{status:400});
      const p=req.body?.product||{};
      const name=clean(p.name,250);
      if(!name)throw Object.assign(new Error('Product name required.'),{status:400});
      const key=itemKey(p);
      const result=await pool.query(`INSERT INTO scanner_preorder_staged_items
       (campaign_id,supplier_id,item_key,item_name,sku,supplier_sku,upc,description,cost,msrp,map_price,weight_text,image_url,source_url,staged_by)
       SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15
       WHERE EXISTS(SELECT 1 FROM preorder_campaigns WHERE id=$1
         AND UPPER(COALESCE(status,'')) NOT IN ('CANCELLED','CLOSED','COMPLETE','COMPLETED','ARCHIVED'))
       AND EXISTS(SELECT 1 FROM suppliers WHERE id=$2 AND is_active=TRUE)
       ON CONFLICT(campaign_id,item_key) DO NOTHING
       RETURNING id,item_name,status`,[
         campaignId,supplierId,key,name,clean(p.sku,128)||null,clean(p.supplierSku,128)||null,clean(p.upc,18)||null,
         clean(p.description,3000)||null,money(p.cost),money(p.msrp),money(p.mapPrice),
         clean(p.weight,60)||null,clean(p.imageUrl,800)||null,clean(req.body?.sourceUrl,1000)||null,e.id
       ]);
      if(!result.rows.length)return res.status(409).json({error:'Already staged, campaign unavailable, or supplier inactive.'});
      res.status(201).json({staged:true,item:{name:result.rows[0].item_name,status:result.rows[0].status}});
    }catch(error){fail(res,error);}
  });
  return router;
}
