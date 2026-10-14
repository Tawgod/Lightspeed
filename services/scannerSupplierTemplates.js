// Shared supplier page reference snapshots and reviewed extraction selectors.
// This module is inert unless explicitly mounted behind scanner authentication.
// Screenshots are stored in Postgres only after a separately authorized upload.
import express from 'express';

const MAX_BYTES=250000;
const MAX_DOMAIN_LENGTH=253;
const SAFE_FIELD_NAMES=new Set(['supplierSku','upc','name','brand','cost','msrp','weight','description']);
function validatedDomain(value){
  const domain=String(value||'').trim().toLowerCase().replace(/^www\./,'');
  if(domain.length>MAX_DOMAIN_LENGTH||!domain.includes('.')||!(/^[a-z0-9.-]+$/.test(domain))||domain.split('.').some(x=>!x||x.startsWith('-')||x.endsWith('-'))){
    throw Object.assign(new Error('Invalid supplier domain.'),{status:400});
  }
  return domain;
}
function reviewedSelectors(input){
  if(input===undefined||input===null)return {};
  if(typeof input!=='object'||Array.isArray(input)||Object.keys(input).length>8)throw Object.assign(new Error('Invalid selectors.'),{status:400});
  const selectors={};
  for(const [field,selector] of Object.entries(input)){
    if(!SAFE_FIELD_NAMES.has(field)||typeof selector!=='string'||selector.length>160||!selector.trim()||/[<>\n\r]/.test(selector)){
      throw Object.assign(new Error('Invalid selector definition.'),{status:400});
    }
    selectors[field]=selector.trim();
  }
  return selectors;
}
function validateSnapshot(body){
  const domain=validatedDomain(body?.domain);
  const name=String(body?.supplierName||'').trim();
  if(!name||name.length>160)throw Object.assign(new Error('Supplier name is required.'),{status:400});
  const image=body?.image;
  if(typeof image!=='string'||!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(image)){
    throw Object.assign(new Error('JPEG snapshot required.'),{status:400});
  }
  const base64=image.substring('data:image/jpeg;base64,'.length);
  if(base64.length>Math.ceil(MAX_BYTES*4/3)+4)throw Object.assign(new Error('Snapshot too large.'),{status:413});
  const bytes=Buffer.from(base64,'base64');
  if(bytes.length<4||bytes.length>MAX_BYTES||bytes[0]!==0xff||bytes[1]!==0xd8||bytes[bytes.length-2]!==0xff||bytes[bytes.length-1]!==0xd9){
    throw Object.assign(new Error('Invalid JPEG snapshot.'),{status:400});
  }
  return {domain,name,image:bytes,selectors:reviewedSelectors(body?.selectors)};
}
export async function initializeScannerSupplierTemplates(pool){
  await pool.query(`CREATE TABLE IF NOT EXISTS scanner_supplier_templates (
    domain TEXT PRIMARY KEY,
    supplier_name TEXT NOT NULL,
    snapshot_jpeg BYTEA,
    selectors JSONB NOT NULL DEFAULT '{}'::jsonb,
    status TEXT NOT NULL DEFAULT 'REFERENCE' CHECK(status IN ('REFERENCE','REVIEWED')),
    last_updated_by BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
}
export function createScannerSupplierTemplatesRouter({pool,verifyEmployee}={}){
  const router=express.Router();
  router.use(express.json({limit:'450kb'}));
  router.use((_req,res,next)=>{res.set('Cache-Control','no-store');next();});
  async function employee(req,requiredApproval=false){
    if(typeof verifyEmployee!=='function')throw Object.assign(new Error('Scanner authentication unavailable.'),{status:503});
    const identity=await verifyEmployee(req);
    if(!identity?.id||!identity.canLookup)throw Object.assign(new Error('Scanner lookup denied.'),{status:403});
    if(requiredApproval&&!identity.canApprove)throw Object.assign(new Error('Template editing requires approval permission.'),{status:403});
    return identity;
  }
  const fail=(res,error)=>res.status([400,401,403,404,413,503].includes(error?.status)?error.status:503).json({error:error?.status&&error.status<500?error.message:'Supplier templates unavailable.'});
  router.get('/templates',async(req,res)=>{
    try{
      await employee(req);
      const result=await pool.query('SELECT domain,supplier_name,status,updated_at FROM scanner_supplier_templates ORDER BY supplier_name LIMIT 100');
      res.json({templates:result.rows});
    }catch(error){fail(res,error);}
  });
  router.get('/templates/:domain',async(req,res)=>{
    try{
      await employee(req);
      const domain=validatedDomain(req.params.domain);
      const result=await pool.query('SELECT domain,supplier_name,status,updated_at,snapshot_jpeg FROM scanner_supplier_templates WHERE domain=$1',[domain]);
      const row=result.rows[0];
      if(!row)return res.status(404).json({error:'Template not found.'});
      res.json({domain:row.domain,supplierName:row.supplier_name,status:row.status,updatedAt:row.updated_at,
        snapshot:row.snapshot_jpeg?'data:image/jpeg;base64,'+row.snapshot_jpeg.toString('base64'):null});
    }catch(error){fail(res,error);}
  });
  router.put('/templates/:domain',async(req,res)=>{
    try{
      const identity=await employee(req,true);
      const body=validateSnapshot(req.body);
      if(validatedDomain(req.params.domain)!==body.domain)return res.status(400).json({error:'Supplier domain mismatch.'});
      const result=await pool.query(`INSERT INTO scanner_supplier_templates
        (domain,supplier_name,snapshot_jpeg,selectors,last_updated_by,status)
        VALUES ($1,$2,$3,$4::jsonb,$5,'REFERENCE')
        ON CONFLICT(domain) DO UPDATE SET supplier_name=EXCLUDED.supplier_name,
        snapshot_jpeg=EXCLUDED.snapshot_jpeg,selectors=EXCLUDED.selectors,
        status='REFERENCE',last_updated_by=EXCLUDED.last_updated_by,updated_at=NOW()
        RETURNING domain,supplier_name,status,updated_at`,
        [body.domain,body.name,body.image,JSON.stringify(body.selectors),identity.id]);
      res.json({saved:true,template:result.rows[0]});
    }catch(error){fail(res,error);}
  });
  return router;
}
