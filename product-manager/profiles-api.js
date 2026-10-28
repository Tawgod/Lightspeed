import express from 'express';

// Isolated module only. Must be mounted behind the existing staff-auth gateway
// after a database migration and acceptance; not activated by this commit.
export async function initializeProductManagerProfiles(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS product_manager_profiles (
    employee_id BIGINT NOT NULL,
    slot TEXT NOT NULL CHECK (slot IN ('Default','Profile 1','Profile 2','Profile 3')),
    config JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (employee_id,slot)
  )`);
}
export function validateProfileConfig(config){
  if(!config || typeof config!=='object'||Array.isArray(config))return false;
  const keys=Object.keys(config);
  if(keys.some(k=>!['columns','hidden','widths','detailsOrder'].includes(k)))return false;
  const validIds=a=>Array.isArray(a)&&a.length<=100&&a.every(x=>typeof x==='string'&&/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(x))&&new Set(a).size===a.length;
  if(config.columns!==undefined&&!validIds(config.columns))return false;
  if(config.hidden!==undefined&&!validIds(config.hidden))return false;
  if(config.detailsOrder!==undefined&&!validIds(config.detailsOrder))return false;
  if(config.widths!==undefined){
    if(!config.widths||typeof config.widths!=='object'||Array.isArray(config.widths))return false;
    if(Object.entries(config.widths).length>100)return false;
    for(const [key,value] of Object.entries(config.widths)){
      if(!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key)||!Number.isInteger(value)||value<48||value>1000)return false;
    }
  }
  return true;
}
export function createProductManagerProfilesRouter({pool,verifyEmployee}={}){
 if(!pool?.query||typeof verifyEmployee!=='function')throw new Error('Authenticated profile storage required.');
 const router=express.Router();
 router.use(express.json({limit:'16kb'}));
 router.use(async(req,res,next)=>{
   res.set('Cache-Control','no-store');
   try{
     const employee=await verifyEmployee(req);
     const id=Number(employee?.id);
     if(!Number.isSafeInteger(id)||id<=0)return res.status(403).json({error:'Employee access denied.'});
     req.productManagerEmployeeId=id;next();
   }catch(error){res.status([401,403,503].includes(error.status)?error.status:503).json({error:'Employee authorization unavailable.'});}
 });
 router.get('/profiles',async(req,res)=>{
   try{
     const rows=await pool.query('SELECT slot,config,updated_at FROM product_manager_profiles WHERE employee_id=$1 ORDER BY slot',[req.productManagerEmployeeId]);
     res.json({profiles:rows.rows});
   }catch{res.status(503).json({error:'Saved profiles unavailable.'});}
 });
 router.put('/profiles/:slot',async(req,res)=>{
   const slot=req.params.slot;
   if(!['Default','Profile 1','Profile 2','Profile 3'].includes(slot))return res.status(400).json({error:'Invalid profile slot.'});
   if(!validateProfileConfig(req.body?.config))return res.status(400).json({error:'Invalid profile layout.'});
   try{
     const result=await pool.query(`INSERT INTO product_manager_profiles(employee_id,slot,config)
       VALUES ($1,$2,$3::jsonb)
       ON CONFLICT(employee_id,slot) DO UPDATE SET config=EXCLUDED.config,updated_at=now()
       RETURNING slot,config,updated_at`,[req.productManagerEmployeeId,slot,JSON.stringify(req.body.config)]);
     res.json({profile:result.rows[0]});
   }catch{res.status(503).json({error:'Profile not saved. Try again.'});}
 });
 return router;
}
