// Product Scanner lookup gateway. NOT mounted in server.js until an employee
// identity verifier and deployment policy have been approved and implemented.
// Reuses existing Special Orders matching routes; contains no product writes.
import express from 'express';

const MAX_FIELD_LENGTH = 500;
function clean(value, max = MAX_FIELD_LENGTH) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

export function validateScannerLookup(body = {}) {
  const input = {
    product_code: clean(body.product_code, 128),
    sku: clean(body.sku, 128),
    supplier_sku: clean(body.supplier_sku, 128),
    name: clean(body.name, 250),
    description: clean(body.description, 500)
  };
  if (!input.product_code && !input.sku && !input.supplier_sku && !input.name) {
    throw Object.assign(new Error('Product UPC, SKU, or name is required.'), { status: 400 });
  }
  return input;
}

export function publicScannerMatch(row = {}, source) {
  const lsId = row.lightspeed_product_id || (source === 'lightspeed' ? row.id : null);
  return {
    local_id: source === 'local' ? (row.local_id || row.id || null) : null,
    lightspeed_product_id: lsId || null,
    id: source === 'lightspeed' ? lsId : null,
    name: clean(row.name, 500),
    sku: clean(row.sku, 128),
    upc: clean(row.upc, 128),
    description: clean(row.description, 2000),
    brand: clean(row.brand, 250),
    weight: row.weight == null ? null : String(row.weight).slice(0,80),
    imageUrl: clean(row.image_url || row.imageUrl || row.image?.url || row.images?.[0]?.url || row.image, 500),
    weightKnown: row.weight !== undefined && row.weight !== null,
    pictureKnown: row.image_url !== undefined || row.imageUrl !== undefined || row.image !== undefined || row.images !== undefined,
    score: Number.isFinite(Number(row.score)) ? Math.max(0, Math.min(100, Number(row.score))) : 0,
    reasons: Array.isArray(row.reasons) ? row.reasons.filter(s => typeof s === 'string').slice(0, 8) : []
  };
}

/**
 * verifyEmployee(req) must resolve to a trusted employee identity established
 * server-side (not an extension ID, bearer key shipped in client code, or tab URL).
 * lookup(kind, payload) must call the existing Special Orders match-local/match-remote
 * service through a backend-only credential. Neither is provided here.
 */
export function createScannerMatchGateway({ verifyEmployee, lookup, supplierLookup } = {}) {
  const router = express.Router();
  router.use(express.json({ limit: '16kb' }));
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.get('/suppliers',async(req,res)=>{
    try{
      const employee=await verifyEmployee(req);
      if(!employee?.id||!employee.canLookup)return res.status(403).json({error:'Scanner lookup denied.'});
      if(typeof supplierLookup!=='function')return res.status(503).json({error:'Supplier lookup unavailable.'});
      const suppliers=await supplierLookup();
      if(!Array.isArray(suppliers))throw new Error('Invalid supplier response');
      return res.json({suppliers:suppliers.slice(0,500).map(row=>({id:String(row.id),name:clean(row.name,160)}))});
    }catch(error){return res.status([401,403].includes(error?.status)?error.status:503).json({error:'Supplier lookup unavailable.'});}
  });
  router.post('/matches', async (req, res) => {
    if (typeof verifyEmployee !== 'function' || typeof lookup !== 'function') {
      return res.status(503).json({ error: 'Scanner employee authentication is not configured.' });
    }
    try {
      const employee = await verifyEmployee(req);
      if (!employee?.id) return res.status(401).json({ error: 'Employee authentication required.' });
      const payload = validateScannerLookup(req.body);
      const [local, remote] = await Promise.all([
        lookup('local', payload, employee),
        lookup('remote', payload, employee)
      ]);
      if (!Array.isArray(local?.matches) || !Array.isArray(remote?.matches)) {
        return res.status(502).json({ error: 'Both product lookups must succeed.' });
      }
      return res.json({
        verified: true,
        local: { matches: local.matches.slice(0,25).map(x => publicScannerMatch(x, 'local')) },
        remote: { matches: remote.matches.slice(0,25).map(x => publicScannerMatch(x, 'lightspeed')) }
      });
    } catch (error) {
      return res.status([400,401,403].includes(error.status) ? error.status : 502)
        .json({ error: [400,401,403].includes(error.status) ? error.message : 'Product verification unavailable.' });
    }
  });
  return router;
}
