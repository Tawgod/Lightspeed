import express from 'express';

// One-shot audited test-only creation. Uncertain results are never retried
// automatically; a reviewer must reconcile the isolated test store.
export async function initializeScannerTestCreation(pool){
  await pool.query(`CREATE TABLE IF NOT EXISTS scanner_test_creation_attempts(
    id BIGSERIAL PRIMARY KEY,
    proposal_id BIGINT NOT NULL UNIQUE REFERENCES scanner_product_review_proposals(id),
    employee_id BIGINT NOT NULL,
    status TEXT NOT NULL DEFAULT 'CHECKING' CHECK(status IN
      ('CHECKING','CREATED','DUPLICATE','RECONCILE_REQUIRED')),
    remote_product_id TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ
  )`);
}
export function createScannerTestCreationRouter({pool,verifyEmployee,lookup,testWriter}={}){
  const router=express.Router();
  router.use(express.json({limit:'1kb'}));
  router.use((_req,res,next)=>{res.set('Cache-Control','no-store');next();});
  router.get('/product-test-creation/status',async(req,res)=>{
    try{
      const employee=await verifyEmployee(req);
      if(!employee?.id||!employee.canLookup)return res.status(403).json({error:'Active Timeclock login required.'});
      return res.json({enabled:typeof testWriter==='function',mode:'isolated-test-tenant'});
    }catch{return res.status(403).json({error:'Active Timeclock login required.'});}
  });
  router.post('/product-proposals/:id/test-create',async(req,res)=>{
    if(typeof testWriter!=='function')return res.status(503).json({error:'An isolated Lightspeed test tenant is not configured. Live store creation is disabled.'});
    const id=Number(req.params.id);
    if(!Number.isSafeInteger(id)||id<=0)return res.status(400).json({error:'Valid proposal required.'});
    if(req.body?.confirmation!=='CREATE TEST PRODUCT')
      return res.status(400).json({error:'Explicit test creation confirmation required.'});
    let claimId=null;
    try{
      const employee=await verifyEmployee(req);
      if(!employee?.id||!employee.canLookup)return res.status(403).json({error:'Active Timeclock login required.'});
      const row=await pool.query(`SELECT id,product_payload,status FROM scanner_product_review_proposals WHERE id=$1`,[id]);
      const proposal=row.rows[0];
      if(!proposal||proposal.status!=='PENDING_REVIEW')return res.status(409).json({error:'Only pending new-item proposals can be test-created.'});
      const p=proposal.product_payload;
      if(String(req.body?.expectedSku||'')!==String(p.sku||p.supplierSku||''))
        return res.status(409).json({error:'Product SKU changed. Refresh the proposal before testing.'});
      const claimed=await pool.query(`INSERT INTO scanner_test_creation_attempts(proposal_id,employee_id)
        VALUES($1,$2) ON CONFLICT(proposal_id) DO NOTHING RETURNING id`,[id,employee.id]);
      claimId=claimed.rows[0]?.id||null;
      if(!claimId)return res.status(409).json({error:'This proposal already has a test creation attempt. Review the test store; do not repeat blindly.'});
      const payload={product_code:p.upc||p.sku,sku:p.sku,supplier_sku:p.supplierSku,name:p.name,description:p.description};
      const [local,remote]=await Promise.all([lookup('local',payload,employee),lookup('remote',payload,employee)]);
      if(!Array.isArray(local?.matches)||!Array.isArray(remote?.matches))
        throw new Error('Duplicate lookup incomplete.');
      if(local.matches.length||remote.matches.length){
        await pool.query(`UPDATE scanner_test_creation_attempts SET status='DUPLICATE',finished_at=now() WHERE id=$1`,[claimId]);
        return res.status(409).json({error:'Potential existing live product found. Test creation blocked.'});
      }
      // This writer has its own test-tenant SKU duplicate check and cannot
      // be configured with the live production store domain.
      const created=await testWriter(p);
      await pool.query(`UPDATE scanner_test_creation_attempts
        SET status='CREATED',remote_product_id=$2,finished_at=now() WHERE id=$1`,[claimId,created.id]);
      return res.status(201).json({testCreated:true,mode:'isolated-test-tenant',product:created});
    }catch(error){
      if(claimId)await pool.query(`UPDATE scanner_test_creation_attempts
        SET status='RECONCILE_REQUIRED',finished_at=now() WHERE id=$1`,[claimId]).catch(()=>{});
      return res.status(503).json({error:'Test creation was not confirmed. Check the isolated test store before retrying; no automatic retries.'});
    }
  });
  return router;
}
