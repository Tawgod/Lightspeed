import express from 'express';
import pg from 'pg';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';
import { importLegacyWorkbook } from './special-orders-import.js';
import { registerSpecialOrderProductRoutes } from './routes/specialOrderProducts.js';

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const VALID_STATUSES = new Set([
  'PREORDER','OOS','READY_TO_ORDER','ORDERED','BACKORDERED',
  'RECEIVED','HELD','CUSTOMER_NOTIFIED','COMPLETED','CANCELLED'
]);

let pool = null;

export async function initializeSpecialOrdersDb() {
  if (!process.env.DATABASE_URL) {
    console.warn('[special-orders] DATABASE_URL not configured; database routes will return 503.');
    return false;
  }

  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined
  });

  const schema = await fs.readFile(path.join(__dirname, 'db', 'special_orders_schema.sql'), 'utf8');
  await pool.query(schema);
  const supplierSeed = await fs.readFile(path.join(__dirname, 'db', 'suppliers_seed.sql'), 'utf8');
  await pool.query(supplierSeed);
  console.log('[special-orders] database schema ready');
  return true;
}

function requireDb(req, res, next) {
  if (!pool) return res.status(503).json({ error: 'Special-order database is not configured yet.' });
  next();
}

function lightspeedHeaders(token, includeJson = true) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    ...(includeJson ? { 'Content-Type': 'application/json' } : {}),
    'User-Agent': 'HobbyCorner-SpecialOrders/1.0'
  };
}

let uspsTokenCache={token:null,expiresAt:0};

async function getUspsAccessToken() {
  const clientId=String(process.env.USPS_CLIENT_ID||'').trim();
  const clientSecret=String(process.env.USPS_CLIENT_SECRET||'').trim();
  if(!clientId||!clientSecret) throw Object.assign(new Error('USPS address verification is not configured yet.'),{status:503});
  if(uspsTokenCache.token && Date.now()<uspsTokenCache.expiresAt-60000) return uspsTokenCache.token;

  const response=await fetch('https://apis.usps.com/oauth2/v3/token',{
    method:'POST',
    headers:{'Content-Type':'application/json','Accept':'application/json'},
    body:JSON.stringify({client_id:clientId,client_secret:clientSecret,grant_type:'client_credentials'})
  });
  const text=await response.text();
  let body={};try{body=text?JSON.parse(text):{}}catch{}
  if(!response.ok||!body.access_token){
    throw Object.assign(new Error('USPS OAuth failed: '+(body.error_description||body.error||response.statusText)),{status:502});
  }
  uspsTokenCache={
    token:body.access_token,
    expiresAt:Date.now()+Math.max(300,Number(body.expires_in||3600))*1000
  };
  return body.access_token;
}

async function verifyUspsAddress(input={}) {
  const street=String(input.street_address||'').trim();
  const secondary=String(input.secondary_address||'').trim();
  const city=String(input.city||'').trim();
  const state=String(input.state||'').trim().toUpperCase();
  const zip=String(input.zip||'').replace(/\D/g,'').slice(0,5);
  if(!street) throw Object.assign(new Error('Street address is required.'),{status:400});
  if(!city&&!zip) throw Object.assign(new Error('City/state or ZIP is required.'),{status:400});

  const token=await getUspsAccessToken();
  const params=new URLSearchParams({streetAddress:street});
  if(secondary)params.set('secondaryAddress',secondary);
  if(city)params.set('city',city);
  if(state)params.set('state',state);
  if(zip)params.set('ZIPCode',zip);

  const response=await fetch('https://apis.usps.com/addresses/v3/address?'+params.toString(),{
    headers:{'Accept':'application/json','Authorization':'Bearer '+token}
  });
  const text=await response.text();
  let body={};try{body=text?JSON.parse(text):{}}catch{}
  if(!response.ok){
    throw Object.assign(new Error('USPS address validation failed: '+(body.error?.message||body.message||response.statusText)),{status:response.status===400?400:502});
  }
  const a=body.address||body.labelAddress||{};
  return {
    street_address:a.streetAddress||street,
    secondary_address:a.secondaryAddress||secondary||null,
    city:a.city||city,
    state:a.state||state,
    zip:a.ZIPCode||zip,
    zip_plus4:a.ZIPPlus4||null,
    dpv_confirmation:body.additionalInfo?.DPVConfirmation||null,
    business:body.additionalInfo?.business||null,
    vacant:body.additionalInfo?.vacant||null,
    corrections:Array.isArray(body.corrections)?body.corrections:[],
    matches:Array.isArray(body.matches)?body.matches:[]
  };
}

async function lightspeedVersionedFetch(domain, token, endpoint, options = {}, version = '2026-04') {
  if (!domain || !token) throw new Error('LIGHTSPEED_DOMAIN or LIGHTSPEED_TOKEN is missing.');
  const response = await fetch(`https://${domain}.retail.lightspeed.app/api/${version}${endpoint}`, {
    ...options,
    headers: { ...lightspeedHeaders(token), ...(options.headers || {}) }
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) {
    const err = new Error(`Lightspeed ${response.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
    err.status = response.status;
    throw err;
  }
  return body;
}

async function ensureLightspeedTag(domain, token, tagName) {
  const listed = await lightspeedVersionedFetch(domain, token, '/tags?page_size=1000');
  const tags = listed?.data || listed || [];
  const existing = Array.isArray(tags) ? tags.find(t => String(t.name || '').toLowerCase() === tagName.toLowerCase()) : null;
  if (existing?.id) return existing.id;
  const created = await lightspeedVersionedFetch(domain, token, '/tags', {
    method: 'POST',
    body: JSON.stringify({ name: tagName })
  });
  const tag = created?.data || created;
  if (!tag?.id) throw new Error(`Could not resolve Lightspeed tag "${tagName}".`);
  return tag.id;
}

function validatePublicImageUrl(raw) {
  const u = new URL(raw);
  if (u.protocol !== 'https:') throw new Error('Distributor image URL must use https.');
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h === '0.0.0.0' || h === '127.0.0.1' || h === '::1' ||
      h.startsWith('10.') || h.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) {
    throw new Error('Private/local image URLs are not allowed.');
  }
  return u;
}

async function uploadLightspeedImageFromUrl(domain, token, productId, imageUrl) {
  const url = validatePublicImageUrl(imageUrl);
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Image download failed: ${response.status}`);
  const contentType = String(response.headers.get('content-type') || '').split(';')[0].toLowerCase();
  const allowed = new Set(['image/jpeg','image/png','image/gif','image/tiff','image/webp']);
  if (!allowed.has(contentType)) throw new Error(`Unsupported image type: ${contentType || 'unknown'}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 10 * 1024 * 1024) throw new Error('Image is larger than Lightspeed\'s 10 MB limit.');

  const ext = ({'image/jpeg':'jpg','image/png':'png','image/gif':'gif','image/tiff':'tiff','image/webp':'webp'})[contentType] || 'jpg';
  const form = new FormData();
  form.append('image', new Blob([bytes], { type: contentType }), `special-order.${ext}`);
  const upload = await fetch(
    `https://${domain}.retail.lightspeed.app/api/2.0/products/${encodeURIComponent(productId)}/actions/image_upload`,
    { method:'POST', headers:lightspeedHeaders(token, false), body:form }
  );
  const text = await upload.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!upload.ok) throw new Error(`Lightspeed image upload ${upload.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  return body;
}

async function lightspeedFetch(domain, token, endpoint, options = {}) {
  if (!domain || !token) throw new Error('LIGHTSPEED_DOMAIN or LIGHTSPEED_TOKEN is missing.');
  const response = await fetch(`https://${domain}.retail.lightspeed.app/api/2.0${endpoint}`, {
    ...options,
    headers: { ...lightspeedHeaders(token), ...(options.headers || {}) }
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) {
    const err = new Error(`Lightspeed ${response.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
    err.status = response.status;
    throw err;
  }
  return body;
}

async function upsertLocalProduct(product) {
  if (!pool || !product) return null;
  const codes = Array.isArray(product.product_codes) ? product.product_codes : [];
  const upc = codes.find(c => c?.code)?.code || product.upc || null;
  const result = await pool.query(
    `INSERT INTO products (lightspeed_product_id,name,sku,upc,description,is_active,last_lightspeed_sync_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,now(),now())
     ON CONFLICT (lightspeed_product_id) DO UPDATE SET
       name=EXCLUDED.name, sku=EXCLUDED.sku, upc=COALESCE(EXCLUDED.upc,products.upc),
       description=EXCLUDED.description, is_active=EXCLUDED.is_active,
       last_lightspeed_sync_at=now(), updated_at=now()
     RETURNING *`,
    [product.id, product.name || 'Unnamed product', product.sku || null, upc,
     product.description || null, product.is_active !== false]
  );
  return result.rows[0];
}



function normalizeIdentifier(type, value) {
  const raw = String(value || '').trim();
  const t = String(type || '').toUpperCase();
  if (!raw) return '';
  if (['UPC','EAN','ISBN','GTIN'].includes(t)) return raw.replace(/\D/g,'');
  return raw.toUpperCase().replace(/\s+/g,'').replace(/[^A-Z0-9-]/g,'');
}

async function upsertProductIdentifiers(client, productId, identifiers = [], source = null) {
  for (const ident of identifiers) {
    const type = String(ident?.type || '').trim().toUpperCase();
    const value = String(ident?.value || '').trim();
    const normalized = normalizeIdentifier(type, value);
    if (!type || !value || !normalized) continue;
    await client.query(`
      INSERT INTO product_identifiers
        (product_id,identifier_type,identifier_value,normalized_value,source,supplier_id,is_primary,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,now())
      ON CONFLICT (identifier_type, normalized_value, (COALESCE(supplier_id,0)))
      DO UPDATE SET
        product_id=EXCLUDED.product_id,
        identifier_value=EXCLUDED.identifier_value,
        source=COALESCE(EXCLUDED.source,product_identifiers.source),
        is_primary=product_identifiers.is_primary OR EXCLUDED.is_primary,
        updated_at=now()
    `, [
      productId,type,value,normalized,ident.source || source || null,
      ident.supplier_id || null,Boolean(ident.is_primary)
    ]);
  }
}

function normalizeMatchText(v) {
  return String(v || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchTokens(v) {
  const stop = new Set(['the','and','for','with','from','set','pack','box','kit','edition','new']);
  return normalizeMatchText(v).split(' ').filter(t => t.length > 1 && !stop.has(t));
}

function scorePotentialMatch(query, candidate) {
  const qRaw = String(query || '').trim();
  const q = normalizeMatchText(qRaw);
  const qTokens = matchTokens(qRaw);
  const sku = normalizeMatchText(candidate.sku);
  const upc = normalizeMatchText(candidate.upc);
  const supplierSku = normalizeMatchText(candidate.supplier_sku);
  const name = normalizeMatchText(candidate.name);
  const desc = normalizeMatchText(candidate.description);
  const supplierDesc = normalizeMatchText(candidate.supplier_description);
  const brand = normalizeMatchText(candidate.brand);
  const manufacturer = normalizeMatchText(candidate.manufacturer_text);

  let score = 0;
  const reasons = [];

  if (q && (q === sku || q === upc || q === supplierSku)) {
    score += 100;
    reasons.push('exact code');
  }
  if (q && q === name) {
    score += 80;
    reasons.push('exact name');
  }

  const haystacks = [
    ['name', name, 34],
    ['description', desc, 22],
    ['supplier description', supplierDesc, 28],
    ['brand', brand, 18],
    ['manufacturer', manufacturer, 18]
  ];
  for (const [label, textValue, weight] of haystacks) {
    if (!textValue || qTokens.length === 0) continue;
    const textTokens = new Set(matchTokens(textValue));
    const hits = qTokens.filter(t => textTokens.has(t));
    if (hits.length) {
      const ratio = hits.length / qTokens.length;
      score += Math.round(weight * ratio);
      if (ratio >= 0.5) reasons.push(`${label} keywords`);
    }
    if (q.length >= 5 && textValue.includes(q)) {
      score += 18;
      reasons.push(`${label} phrase`);
    }
  }

  // Partial code match is useful for suppliers that add/remove prefixes or punctuation.
  const compactQuery = q.replace(/ /g, '');
  for (const code of [sku, supplierSku, upc]) {
    const compactCode = code.replace(/ /g, '');
    if (compactQuery.length >= 4 && compactCode.length >= 4 &&
        compactQuery !== compactCode &&
        (compactCode.includes(compactQuery) || compactQuery.includes(compactCode))) {
      score += 24;
      reasons.push('partial code');
      break;
    }
  }

  return { score: Math.min(score, 100), reasons: [...new Set(reasons)] };
}

export function createSpecialOrdersRouter({
  lightspeedDomain,
  lightspeedToken,
  adminKey,
  liveMode = false,
  allowMigration = false,
  allowProductWrites = false,
  lightspeedOutletId = null
}) {
  const router = express.Router();
  console.log('Special Orders auth diagnostic', {
    configured: Boolean(adminKey),
    length: adminKey ? String(adminKey).length : 0,
    trimmedLength: adminKey ? String(adminKey).trim().length : 0
  });
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

  router.get('/health', async (req, res) => {
    res.json({
      ok: true,
      database: Boolean(pool),
      lightspeed: Boolean(lightspeedDomain && lightspeedToken),
      secured: Boolean(adminKey),
      adminKeyLength: adminKey ? String(adminKey).length : 0,
      adminKeyTrimmedLength: adminKey ? String(adminKey).trim().length : 0,
      liveMode: Boolean(liveMode),
      allowMigration: Boolean(allowMigration),
      allowProductWrites: Boolean(allowProductWrites)
    });
  });

  router.use((req, res, next) => {
    if (!adminKey) return res.status(503).json({ error: 'SPECIAL_ORDERS_ADMIN_KEY is not configured.' });
    const suppliedKey = String(req.get('x-hobby-corner-key') || '').trim();
    const configuredKey = String(adminKey || '').trim();
    if (!suppliedKey || suppliedKey !== configuredKey) {
      console.log('Special Orders auth mismatch', {
        suppliedLength: suppliedKey.length,
        configuredLength: configuredKey.length,
        path: req.path
      });
      return res.status(401).json({ error: 'Special-orders access key required.' });
    }
    next();
  });

  router.get('/auth-check', (req, res) => {
    res.json({ ok:true });
  });

  router.post('/import/workbook', requireDb, upload.single('workbook'), async (req, res) => {
    if (!allowMigration) return res.status(423).json({ error: 'Legacy migration is disabled until Lightspeed go-live.' });
    if (!req.file?.buffer) return res.status(400).json({ error: 'Upload an .xlsx workbook in the workbook field.' });
    try {
      const result = await importLegacyWorkbook(pool, req.file.buffer, req.file.originalname);
      res.json(result);
    } catch (error) {
      console.error('[special-orders] workbook import failed:', error);
      res.status(400).json({ error: error.message });
    }
  });

  async function refreshLightspeedPurchaseMetrics(customerId) {
    const customer = await pool.query(
      'SELECT id,lightspeed_customer_id FROM customers WHERE id=$1',
      [customerId]
    );
    const row = customer.rows[0];
    if (!row) throw Object.assign(new Error('Customer not found.'), { status:404 });
    if (!row.lightspeed_customer_id) {
      throw Object.assign(new Error('Customer is not linked to a Lightspeed customer yet.'), { status:409 });
    }

    const pageSize = 1000;
    let offset = 0;
    let purchaseCount = 0;
    let grossSpend = 0;
    let lastPurchaseAt = null;
    let oldestPurchaseAt = null;

    while (offset < 5000) {
      const params = new URLSearchParams({
        type:'sales',
        customer_id:String(row.lightspeed_customer_id),
        state:'closed',
        page_size:String(pageSize),
        offset:String(offset),
        order_by:'date',
        order_direction:'desc'
      });
      const result = await lightspeedVersionedFetch(
        lightspeedDomain,
        lightspeedToken,
        '/search?' + params.toString(),
        {},
        '2026-07'
      );
      const sales = Array.isArray(result?.data) ? result.data : [];
      for (const sale of sales) {
        const total = Number(
          sale.sale_total ??
          sale.total_price ??
          sale.total_price_including_tax ??
          sale.total ??
          sale.total_value ??
          0
        );
        if (Number.isFinite(total) && total > 0) grossSpend += total;
        purchaseCount++;

        const rawDate = sale.date || sale.sale_date || sale.created_at || sale.updated_at || null;
        const parsed = rawDate ? new Date(rawDate) : null;
        if (parsed && !Number.isNaN(parsed.getTime())) {
          if (!lastPurchaseAt || parsed > lastPurchaseAt) lastPurchaseAt = parsed;
          if (!oldestPurchaseAt || parsed < oldestPurchaseAt) oldestPurchaseAt = parsed;
        }
      }
      if (sales.length < pageSize) break;
      offset += pageSize;
    }

    const { rows } = await pool.query(`
      INSERT INTO customer_purchase_metrics
        (customer_id,source,period_start,period_end,purchase_count,gross_spend,last_purchase_at,metadata,updated_at)
      VALUES ($1,'LIGHTSPEED',$2,$3,$4,$5,$6,$7::jsonb,now())
      ON CONFLICT (customer_id,source) DO UPDATE SET
        period_start=EXCLUDED.period_start,
        period_end=EXCLUDED.period_end,
        purchase_count=EXCLUDED.purchase_count,
        gross_spend=EXCLUDED.gross_spend,
        last_purchase_at=EXCLUDED.last_purchase_at,
        metadata=EXCLUDED.metadata,
        updated_at=now()
      RETURNING *
    `, [
      customerId,
      oldestPurchaseAt ? oldestPurchaseAt.toISOString().slice(0,10) : null,
      lastPurchaseAt ? lastPurchaseAt.toISOString().slice(0,10) : null,
      purchaseCount,
      grossSpend.toFixed(2),
      lastPurchaseAt ? lastPurchaseAt.toISOString() : null,
      JSON.stringify({ capped_at_sales:5000 })
    ]);
    return rows[0];
  }

  router.post('/customers/:id/purchase-metrics/lightspeed-refresh', requireDb, async (req, res) => {
    try {
      res.json(await refreshLightspeedPurchaseMetrics(req.params.id));
    } catch (error) {
      res.status(error.status || 502).json({ error:error.message });
    }
  });

  router.post('/customers/:id/purchase-metrics', requireDb, async (req, res) => {
    const source = String(req.body?.source || '').trim().toUpperCase();
    if (!source || source === 'LIGHTSPEED') {
      return res.status(400).json({ error:'Use a non-Lightspeed source such as RMS.' });
    }
    const purchaseCount = Math.max(0, Number(req.body?.purchase_count || 0));
    const grossSpend = Math.max(0, Number(req.body?.gross_spend || 0));
    const { rows } = await pool.query(`
      INSERT INTO customer_purchase_metrics
        (customer_id,source,period_start,period_end,purchase_count,gross_spend,last_purchase_at,metadata,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,now())
      ON CONFLICT (customer_id,source) DO UPDATE SET
        period_start=EXCLUDED.period_start,
        period_end=EXCLUDED.period_end,
        purchase_count=EXCLUDED.purchase_count,
        gross_spend=EXCLUDED.gross_spend,
        last_purchase_at=EXCLUDED.last_purchase_at,
        metadata=EXCLUDED.metadata,
        updated_at=now()
      RETURNING *
    `, [
      req.params.id,source,req.body?.period_start||null,req.body?.period_end||null,
      purchaseCount,grossSpend,req.body?.last_purchase_at||null,
      JSON.stringify(req.body?.metadata||{})
    ]);
    res.json(rows[0]);
  });

  router.get('/preorders/products/:id/allocation-suggestions', requireDb, async (req, res) => {
    const product = await pool.query(`
      SELECT pp.*,pc.name AS campaign_name,pc.allocation_method
      FROM preorder_products pp
      JOIN preorder_campaigns pc ON pc.id=pp.preorder_campaign_id
      WHERE pp.id=$1
    `, [req.params.id]);
    if (!product.rows[0]) return res.status(404).json({ error:'Preorder product not found.' });

    if (String(req.query.refresh_lightspeed || '') === '1') {
      const stale = await pool.query(`
        SELECT DISTINCT pr.customer_id,c.lightspeed_customer_id,pm.updated_at
        FROM preorder_requests pr
        JOIN customers c ON c.id=pr.customer_id
        LEFT JOIN preorder_allocations pa ON pa.preorder_request_id=pr.id
        LEFT JOIN customer_purchase_metrics pm
          ON pm.customer_id=pr.customer_id AND pm.source='LIGHTSPEED'
        WHERE pr.preorder_product_id=$1
          AND pr.status='REQUESTED'
          AND pa.id IS NULL
          AND c.lightspeed_customer_id IS NOT NULL
          AND (pm.updated_at IS NULL OR pm.updated_at < now()-interval '24 hours')
        LIMIT 40
      `, [req.params.id]);
      await Promise.allSettled(stale.rows.map(x => refreshLightspeedPurchaseMetrics(x.customer_id)));
    }

    const requests = await pool.query(`
      SELECT
        pr.id AS request_id,
        pr.customer_id,
        pr.requested_quantity,
        pr.queue_position,
        pr.requested_at,
        c.name AS customer_name,
        c.discord_handle,
        c.lightspeed_customer_id,
        COALESCE(hist.picked_up,0)::int AS picked_up,
        COALESCE(hist.late_pickups,0)::int AS late_pickups,
        COALESCE(hist.no_pickups,0)::int AS no_pickups,
        hist.last_no_pickup,
        COALESCE(pm.purchase_count,0)::int AS purchase_count,
        COALESCE(pm.gross_spend,0)::numeric AS gross_spend,
        pm.last_purchase_at,
        pm.sources,
        pm.metrics_updated_at
      FROM preorder_requests pr
      JOIN customers c ON c.id=pr.customer_id
      LEFT JOIN preorder_allocations pa ON pa.preorder_request_id=pr.id
      LEFT JOIN LATERAL (
        SELECT
          count(*) FILTER (WHERE event_type='PICKED_UP') AS picked_up,
          count(*) FILTER (WHERE event_type='LATE_PICKUP') AS late_pickups,
          count(*) FILTER (WHERE event_type='NO_PICKUP') AS no_pickups,
          max(occurred_at) FILTER (WHERE event_type='NO_PICKUP') AS last_no_pickup
        FROM customer_pickup_events
        WHERE customer_id=pr.customer_id
      ) hist ON true
      LEFT JOIN LATERAL (
        SELECT
          COALESCE(sum(purchase_count),0) AS purchase_count,
          COALESCE(sum(gross_spend),0) AS gross_spend,
          max(last_purchase_at) AS last_purchase_at,
          string_agg(source,',' ORDER BY source) AS sources,
          min(updated_at) AS metrics_updated_at
        FROM customer_purchase_metrics
        WHERE customer_id=pr.customer_id
      ) pm ON true
      WHERE pr.preorder_product_id=$1
        AND pr.status='REQUESTED'
        AND pa.id IS NULL
      ORDER BY COALESCE(pr.queue_position,2147483647),pr.requested_at
    `, [req.params.id]);

    const now = Date.now();
    const ranked = requests.rows.map(r => {
      const spend = Number(r.gross_spend || 0);
      const purchases = Number(r.purchase_count || 0);
      const pickedUp = Number(r.picked_up || 0);
      const late = Number(r.late_pickups || 0);
      const missed = Number(r.no_pickups || 0);
      const lastPurchase = r.last_purchase_at ? new Date(r.last_purchase_at).getTime() : 0;
      const lastMissed = r.last_no_pickup ? new Date(r.last_no_pickup).getTime() : 0;

      const spendPoints = Math.min(25, Math.log10(1 + spend) * 7);
      const purchasePoints = Math.min(15, Math.sqrt(purchases) * 2.5);
      const pickupPoints = Math.min(20, pickedUp * 3);
      const recencyPoints = lastPurchase && (now-lastPurchase) <= 90*86400000 ? 10 :
                            lastPurchase && (now-lastPurchase) <= 365*86400000 ? 5 : 0;
      const latePenalty = Math.min(15, late * 4);
      let missedPenalty = missed * 22;
      if (lastMissed && (now-lastMissed) <= 365*86400000) missedPenalty += 12;
      missedPenalty = Math.min(60, missedPenalty);

      const queueBonus = r.queue_position ? Math.max(0, 8 - Math.min(8, Number(r.queue_position)-1)) : 0;
      const score = Math.max(0, Math.min(100,
        40 + spendPoints + purchasePoints + pickupPoints + recencyPoints + queueBonus - latePenalty - missedPenalty
      ));

      return {
        ...r,
        gross_spend:Number(spend.toFixed(2)),
        allocation_score:Number(score.toFixed(1)),
        score_breakdown:{
          base:40,
          spend:Number(spendPoints.toFixed(1)),
          purchase_frequency:Number(purchasePoints.toFixed(1)),
          successful_pickups:Number(pickupPoints.toFixed(1)),
          purchase_recency:recencyPoints,
          queue_position:Number(queueBonus.toFixed(1)),
          late_pickup_penalty:-Number(latePenalty.toFixed(1)),
          no_pickup_penalty:-Number(missedPenalty.toFixed(1))
        },
        flags:[
          ...(missed>0 ? [missed+' prior no-pickup'+(missed===1?'':'s')] : []),
          ...(late>0 ? [late+' late pickup'+(late===1?'':'s')] : []),
          ...(!r.sources ? ['purchase history not synced'] : [])
        ]
      };
    }).sort((a,b) =>
      b.allocation_score-a.allocation_score ||
      Number(a.queue_position||2147483647)-Number(b.queue_position||2147483647) ||
      new Date(a.requested_at)-new Date(b.requested_at)
    );

    let available = Number(req.query.available_quantity ?? product.rows[0].received_quantity ?? 0);
    available = Math.max(0, available - Number(product.rows[0].reserved_floor_quantity || 0));
    const suggestions = ranked.map(r => {
      const qty = Math.min(Number(r.requested_quantity||1),available);
      available -= qty;
      return { ...r, suggested_quantity:Math.max(0,qty) };
    });

    res.json({
      product:product.rows[0],
      scoring_version:'v1',
      advisory_only:true,
      suggestions
    });
  });

  router.get('/customers/:id/pickup-history', requireDb, async (req, res) => {
    const { rows } = await pool.query(`
      SELECT e.*,
             pr.requested_quantity,
             pp.item_description,
             pc.name AS campaign_name
      FROM customer_pickup_events e
      LEFT JOIN preorder_requests pr ON pr.id=e.preorder_request_id
      LEFT JOIN preorder_products pp ON pp.id=pr.preorder_product_id
      LEFT JOIN preorder_campaigns pc ON pc.id=pp.preorder_campaign_id
      WHERE e.customer_id=$1
      ORDER BY e.occurred_at DESC
      LIMIT 100
    `, [req.params.id]);
    const summary = await pool.query(`
      SELECT
        count(*) FILTER (WHERE event_type='PICKED_UP')::int AS picked_up,
        count(*) FILTER (WHERE event_type='LATE_PICKUP')::int AS late_pickups,
        count(*) FILTER (WHERE event_type='NO_PICKUP')::int AS no_pickups,
        max(occurred_at) FILTER (WHERE event_type='NO_PICKUP') AS last_no_pickup
      FROM customer_pickup_events
      WHERE customer_id=$1
    `, [req.params.id]);
    res.json({ summary: summary.rows[0], events: rows });
  });

  router.get('/preorders/campaigns', requireDb, async (req, res) => {
    const { rows } = await pool.query(`
      SELECT pc.*,
             count(DISTINCT pp.id)::int AS product_count,
             count(DISTINCT pr.id)::int AS request_count
      FROM preorder_campaigns pc
      LEFT JOIN preorder_products pp ON pp.preorder_campaign_id=pc.id
      LEFT JOIN preorder_requests pr ON pr.preorder_product_id=pp.id
      GROUP BY pc.id
      ORDER BY COALESCE(pc.release_date, DATE '9999-12-31'), pc.created_at DESC
    `);
    res.json(rows);
  });

  router.get('/preorders/campaigns/:id', requireDb, async (req, res) => {
    const campaign = await pool.query('SELECT * FROM preorder_campaigns WHERE id=$1', [req.params.id]);
    if (!campaign.rows[0]) return res.status(404).json({ error:'Preorder campaign not found.' });
    const products = await pool.query(`
      SELECT pp.*,
             COALESCE(sum(pr.requested_quantity),0)::int AS requested_total,
             COALESCE(sum(pa.quantity) FILTER (WHERE pa.status IN ('ALLOCATED','READY','PICKED_UP')),0)::int AS allocated_total
      FROM preorder_products pp
      LEFT JOIN preorder_requests pr ON pr.preorder_product_id=pp.id
      LEFT JOIN preorder_allocations pa ON pa.preorder_request_id=pr.id
      WHERE pp.preorder_campaign_id=$1
      GROUP BY pp.id
      ORDER BY pp.release_date, pp.item_description
    `, [req.params.id]);
    res.json({ campaign:campaign.rows[0], products:products.rows });
  });

  router.get('/preorders/products/:id/requests', requireDb, async (req, res) => {
    const { rows } = await pool.query(`
      SELECT pr.*, c.name AS customer_name, c.phone, c.discord_handle,
             pa.quantity AS allocated_quantity, pa.status AS allocation_status,
             pa.pickup_deadline_at, pa.picked_up_at,
             hist.no_pickups, hist.late_pickups
      FROM preorder_requests pr
      JOIN customers c ON c.id=pr.customer_id
      LEFT JOIN preorder_allocations pa ON pa.preorder_request_id=pr.id
      LEFT JOIN LATERAL (
        SELECT
          count(*) FILTER (WHERE e.event_type='NO_PICKUP')::int AS no_pickups,
          count(*) FILTER (WHERE e.event_type='LATE_PICKUP')::int AS late_pickups
        FROM customer_pickup_events e WHERE e.customer_id=pr.customer_id
      ) hist ON true
      WHERE pr.preorder_product_id=$1
      ORDER BY COALESCE(pr.queue_position,2147483647), pr.requested_at
    `, [req.params.id]);
    res.json(rows);
  });

  router.post('/preorders/products/:id/allocate', requireDb, async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const productResult = await client.query(`
        SELECT pp.*, pc.allocation_method, pc.pickup_window_days
        FROM preorder_products pp
        JOIN preorder_campaigns pc ON pc.id=pp.preorder_campaign_id
        WHERE pp.id=$1 FOR UPDATE
      `, [req.params.id]);
      const product = productResult.rows[0];
      if (!product) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error:'Preorder product not found.' });
      }

      const available = Math.max(0, Number(req.body?.available_quantity ?? product.received_quantity) - Number(product.reserved_floor_quantity || 0));
      const method = String(req.body?.method || product.allocation_method || 'QUEUE').toUpperCase();
      if (!['QUEUE','FAIR_SHARE','MANUAL'].includes(method)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error:'Allocation method must be QUEUE, FAIR_SHARE, or MANUAL.' });
      }

      const existingAlloc = await client.query(`
        SELECT COALESCE(sum(quantity),0)::int AS qty
        FROM preorder_allocations pa
        JOIN preorder_requests pr ON pr.id=pa.preorder_request_id
        WHERE pr.preorder_product_id=$1 AND pa.status IN ('ALLOCATED','READY','PICKED_UP')
      `, [req.params.id]);
      let remaining = Math.max(0, available - Number(existingAlloc.rows[0].qty || 0));

      const requests = await client.query(`
        SELECT pr.*, c.name AS customer_name
        FROM preorder_requests pr
        JOIN customers c ON c.id=pr.customer_id
        LEFT JOIN preorder_allocations pa ON pa.preorder_request_id=pr.id
        WHERE pr.preorder_product_id=$1
          AND pr.status='REQUESTED'
          AND pa.id IS NULL
        ORDER BY COALESCE(pr.queue_position,2147483647), pr.requested_at
        FOR UPDATE OF pr
      `, [req.params.id]);

      const created = [];
      if (method === 'MANUAL') {
        const manual = Array.isArray(req.body?.allocations) ? req.body.allocations : [];
        for (const a of manual) {
          const request = requests.rows.find(r => String(r.id) === String(a.request_id));
          const qty = Math.min(Number(a.quantity || 0), Number(request?.requested_quantity || 0), remaining);
          if (!request || qty <= 0) continue;
          const r = await client.query(
            'INSERT INTO preorder_allocations (preorder_request_id,quantity) VALUES ($1,$2) RETURNING *',
            [request.id, qty]
          );
          await client.query('UPDATE preorder_requests SET status=$1 WHERE id=$2', ['ALLOCATED',request.id]);
          created.push(r.rows[0]); remaining -= qty;
        }
      } else if (method === 'FAIR_SHARE') {
        // One each in queue order, then another pass, until stock is exhausted.
        const need = requests.rows.map(r => ({...r, left:Number(r.requested_quantity)}));
        while (remaining > 0 && need.some(r => r.left > 0)) {
          for (const r of need) {
            if (remaining <= 0) break;
            if (r.left <= 0) continue;
            r.left--; remaining--;
            const found = created.find(x => String(x.preorder_request_id)===String(r.id));
            if (found) {
              found.quantity++;
              await client.query('UPDATE preorder_allocations SET quantity=quantity+1 WHERE id=$1',[found.id]);
            } else {
              const ins = await client.query(
                'INSERT INTO preorder_allocations (preorder_request_id,quantity) VALUES ($1,1) RETURNING *',[r.id]
              );
              created.push(ins.rows[0]);
              await client.query('UPDATE preorder_requests SET status=$1 WHERE id=$2',['ALLOCATED',r.id]);
            }
          }
        }
      } else {
        for (const r of requests.rows) {
          if (remaining <= 0) break;
          const qty = Math.min(Number(r.requested_quantity), remaining);
          const ins = await client.query(
            'INSERT INTO preorder_allocations (preorder_request_id,quantity) VALUES ($1,$2) RETURNING *',[r.id,qty]
          );
          created.push(ins.rows[0]);
          await client.query('UPDATE preorder_requests SET status=$1 WHERE id=$2',['ALLOCATED',r.id]);
          remaining -= qty;
        }
      }

      await client.query('COMMIT');
      res.json({ method, available, newlyAllocated:created.reduce((s,x)=>s+Number(x.quantity),0), remaining, allocations:created });
    } catch (error) {
      await client.query('ROLLBACK');
      res.status(400).json({ error:error.message });
    } finally { client.release(); }
  });

  router.patch('/preorders/allocations/:id', requireDb, async (req, res) => {
    const action=String(req.body?.action||'').toUpperCase();
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      const q=await client.query(`
        SELECT pa.*, pr.customer_id, pp.item_description, pc.pickup_window_days
        FROM preorder_allocations pa
        JOIN preorder_requests pr ON pr.id=pa.preorder_request_id
        JOIN preorder_products pp ON pp.id=pr.preorder_product_id
        JOIN preorder_campaigns pc ON pc.id=pp.preorder_campaign_id
        WHERE pa.id=$1 FOR UPDATE
      `,[req.params.id]);
      const a=q.rows[0];
      if(!a){await client.query('ROLLBACK');return res.status(404).json({error:'Allocation not found.'})}

      if(action==='READY'){
        const r=await client.query(`
          UPDATE preorder_allocations SET status='READY',ready_at=now(),
            pickup_deadline_at=now()+make_interval(days => $2)
          WHERE id=$1 RETURNING *
        `,[a.id,Number(a.pickup_window_days||7)]);
        await client.query('COMMIT');return res.json(r.rows[0]);
      }
      if(action==='PICKED_UP'){
        const late=a.pickup_deadline_at && new Date(a.pickup_deadline_at)<new Date();
        const r=await client.query(`
          UPDATE preorder_allocations SET status='PICKED_UP',picked_up_at=now() WHERE id=$1 RETURNING *
        `,[a.id]);
        await client.query(`
          INSERT INTO customer_pickup_events (customer_id,preorder_request_id,event_type,notes,created_by)
          VALUES ($1,$2,$3,$4,$5)
        `,[a.customer_id,a.preorder_request_id,late?'LATE_PICKUP':'PICKED_UP',req.body?.note||null,req.body?.changed_by||null]);
        await client.query('COMMIT');return res.json(r.rows[0]);
      }
      if(action==='NO_PICKUP'){
        const r=await client.query(`
          UPDATE preorder_allocations SET status='RELEASED',released_at=now(),
            release_reason='NO_PICKUP'
          WHERE id=$1 RETURNING *
        `,[a.id]);
        await client.query('UPDATE preorder_requests SET status=$1 WHERE id=$2',['NO_PICKUP',a.preorder_request_id]);
        await client.query(`
          INSERT INTO customer_pickup_events (customer_id,preorder_request_id,event_type,notes,created_by)
          VALUES ($1,$2,'NO_PICKUP',$3,$4)
        `,[a.customer_id,a.preorder_request_id,req.body?.note||null,req.body?.changed_by||null]);
        await client.query('COMMIT');return res.json(r.rows[0]);
      }
      await client.query('ROLLBACK');
      return res.status(400).json({error:'action must be READY, PICKED_UP, or NO_PICKUP'});
    } catch(error){
      await client.query('ROLLBACK');res.status(400).json({error:error.message});
    } finally {client.release()}
  });

  router.get('/stats', requireDb, async (req, res) => {
    const { rows } = await pool.query(`
      SELECT
        count(*) FILTER (WHERE status NOT IN ('COMPLETED','CANCELLED'))::int AS open,
        count(*) FILTER (WHERE status='PREORDER')::int AS preorder,
        count(*) FILTER (WHERE status IN ('OOS','READY_TO_ORDER'))::int AS needs_ordering,
        count(*) FILTER (WHERE status='BACKORDERED')::int AS backordered,
        count(*) FILTER (WHERE status IN ('RECEIVED','HELD','CUSTOMER_NOTIFIED'))::int AS ready_or_held,
        count(*) FILTER (WHERE status='ORDERED' AND ordered_at <= now() - interval '7 days')::int AS ordered_over_7_days
      FROM special_order_items
    `);
    res.json(rows[0]);
  });

  router.get('/orders', requireDb, async (req, res) => {
    const params = [];
    const where = [];
    if (req.query.status) {
      params.push(String(req.query.status).toUpperCase());
      where.push(`i.status = $${params.length}`);
    }
    if (req.query.attention === '1') {
      where.push(`i.status='ORDERED' AND i.ordered_at <= now() - interval '7 days'`);
    }
    if (req.query.supplier_id) {
      params.push(req.query.supplier_id);
      where.push(`(i.preferred_supplier_id = $${params.length} OR EXISTS (
        SELECT 1 FROM supplier_products sp WHERE sp.product_id=i.product_id AND sp.supplier_id=$${params.length} AND sp.is_orderable=true
      ))`);
    }
    const { rows } = await pool.query(`
      SELECT i.*, o.created_at AS order_created_at, c.name AS customer_name, c.phone, c.discord_handle,
             p.name AS product_name, p.sku, p.upc, s.name AS preferred_supplier_name,
             CASE WHEN i.status='ORDERED' AND i.ordered_at IS NOT NULL
                  THEN floor(extract(epoch from (now()-i.ordered_at))/86400)::int END AS days_ordered
      FROM special_order_items i
      JOIN special_orders o ON o.id=i.special_order_id
      LEFT JOIN customers c ON c.id=o.customer_id
      LEFT JOIN products p ON p.id=i.product_id
      LEFT JOIN suppliers s ON s.id=i.preferred_supplier_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY
        CASE WHEN i.status='ORDERED' AND i.ordered_at <= now()-interval '7 days' THEN 0 ELSE 1 END,
        i.created_at DESC
      LIMIT 500
    `, params);
    res.json(rows);
  });

  router.post('/orders', requireDb, async (req, res) => {
    const client = await pool.connect();
    try {
      const { customer = {}, items = [], notes = null, source = 'dashboard', created_by = null } = req.body || {};
      if (!customer.name) return res.status(400).json({ error: 'customer.name is required.' });
      if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'At least one item is required.' });

      await client.query('BEGIN');
      const customerResult = await client.query(`
        INSERT INTO customers (lightspeed_customer_id,name,phone,email,discord_user_id,discord_handle,notes,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,now())
        ON CONFLICT (lightspeed_customer_id) DO UPDATE SET
          name=EXCLUDED.name, phone=COALESCE(EXCLUDED.phone,customers.phone),
          email=COALESCE(EXCLUDED.email,customers.email),
          discord_user_id=COALESCE(EXCLUDED.discord_user_id,customers.discord_user_id),
          discord_handle=COALESCE(EXCLUDED.discord_handle,customers.discord_handle),
          notes=COALESCE(EXCLUDED.notes,customers.notes), updated_at=now()
        RETURNING id
      `, [customer.lightspeed_customer_id || null, customer.name, customer.phone || null, customer.email || null,
          customer.discord_user_id || null, customer.discord_handle || null, customer.notes || null]);

      const orderResult = await client.query(
        'INSERT INTO special_orders (customer_id,source,notes,created_by) VALUES ($1,$2,$3,$4) RETURNING *',
        [customerResult.rows[0].id, source, notes, created_by]
      );

      const createdItems = [];
      for (const item of items) {
        const status = String(item.status || 'OOS').toUpperCase();
        if (!VALID_STATUSES.has(status)) throw new Error(`Invalid status: ${status}`);
        const itemResult = await client.query(`
          INSERT INTO special_order_items
            (special_order_id,product_id,requested_name,requested_sku,requested_upc,quantity,status,
             preferred_supplier_id,sourcing_department_id,supplier_needed,placeholder_product,product_data_status,source_url,
             release_date,ordered_at,notes,crowdfunding_note)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *
        `, [
          orderResult.rows[0].id, item.product_id || null, item.requested_name || item.name,
          item.requested_sku || item.sku || null, item.requested_upc || item.upc || null,
          Number(item.quantity || 1), status, item.preferred_supplier_id || null, item.sourcing_department_id || null,
          Boolean(item.supplier_needed), Boolean(item.placeholder_product || !item.product_id),
          String(item.product_data_status || (item.product_id ? 'COMPLETE' : 'NEEDS_LIGHTSPEED_PRODUCT')).toUpperCase(),
          item.source_url || null, item.release_date || null, status === 'ORDERED' ? new Date() : null,
          item.notes || null, item.crowdfunding_note || null
        ]);

        const supplierIds = Array.from(new Set(
          (Array.isArray(item.supplier_ids) ? item.supplier_ids : [])
            .concat(item.preferred_supplier_id ? [item.preferred_supplier_id] : [])
            .filter(Boolean)
        ));
        let supplierPriority = 1;
        for (const supplierId of supplierIds) {
          await client.query(`
            INSERT INTO special_order_item_suppliers
              (special_order_item_id,supplier_id,priority,availability_status,source_url)
            VALUES ($1,$2,$3,$4,$5)
            ON CONFLICT (special_order_item_id,supplier_id) DO UPDATE SET
              priority=LEAST(special_order_item_suppliers.priority,EXCLUDED.priority),
              availability_status=COALESCE(EXCLUDED.availability_status,special_order_item_suppliers.availability_status),
              source_url=COALESCE(EXCLUDED.source_url,special_order_item_suppliers.source_url)
          `, [itemResult.rows[0].id, supplierId, supplierPriority++, item.supplier_availability?.[supplierId] || null,
              item.supplier_source_urls?.[supplierId] || item.source_url || null]);
        }
        await client.query(
          'INSERT INTO order_status_history (special_order_item_id,new_status,note,changed_by) VALUES ($1,$2,$3,$4)',
          [itemResult.rows[0].id, status, 'Order item created', created_by]
        );
        createdItems.push(itemResult.rows[0]);
      }
      await client.query('COMMIT');
      res.status(201).json({ order: orderResult.rows[0], items: createdItems });
    } catch (error) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: error.message });
    } finally {
      client.release();
    }
  });

  router.post('/orders/:id/items', requireDb, async (req, res) => {
    const item = req.body || {};
    const status = String(item.status || 'OOS').toUpperCase();
    if (!VALID_STATUSES.has(status)) return res.status(400).json({ error:'Invalid status.' });
    if (!item.requested_name && !item.name) return res.status(400).json({ error:'Item name is required.' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const order = await client.query('SELECT id FROM special_orders WHERE id=$1', [req.params.id]);
      if (!order.rows[0]) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error:'Special order not found.' });
      }
      const created = await client.query(`
        INSERT INTO special_order_items
          (special_order_id,product_id,requested_name,requested_sku,requested_upc,quantity,status,
           preferred_supplier_id,sourcing_department_id,supplier_needed,placeholder_product,product_data_status,source_url,
           release_date,ordered_at,notes,crowdfunding_note)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
        RETURNING *
      `, [
        req.params.id,item.product_id||null,item.requested_name||item.name,item.requested_sku||item.sku||null,
        item.requested_upc||item.upc||null,Number(item.quantity||1),status,item.preferred_supplier_id||null,
        item.sourcing_department_id||null,Boolean(item.supplier_needed),Boolean(item.placeholder_product || !item.product_id),
        String(item.product_data_status || (item.product_id ? 'COMPLETE' : 'NEEDS_LIGHTSPEED_PRODUCT')).toUpperCase(),
        item.source_url||null,item.release_date||null,status==='ORDERED'?new Date():null,item.notes||null,item.crowdfunding_note||null
      ]);
      const supplierIds=Array.from(new Set((Array.isArray(item.supplier_ids)?item.supplier_ids:[])
        .concat(item.preferred_supplier_id?[item.preferred_supplier_id]:[]).filter(Boolean)));
      let priority=1;
      for(const supplierId of supplierIds){
        await client.query(`
          INSERT INTO special_order_item_suppliers
            (special_order_item_id,supplier_id,priority,availability_status,source_url)
          VALUES ($1,$2,$3,$4,$5)
          ON CONFLICT (special_order_item_id,supplier_id) DO UPDATE SET
            priority=EXCLUDED.priority,
            availability_status=COALESCE(EXCLUDED.availability_status,special_order_item_suppliers.availability_status),
            source_url=COALESCE(EXCLUDED.source_url,special_order_item_suppliers.source_url)
        `,[created.rows[0].id,supplierId,priority++,item.supplier_availability?.[supplierId]||null,
            item.supplier_source_urls?.[supplierId]||item.source_url||null]);
      }
      await client.query(
        'INSERT INTO order_status_history (special_order_item_id,new_status,note,changed_by) VALUES ($1,$2,$3,$4)',
        [created.rows[0].id,status,'Item added to existing order',item.created_by||null]
      );
      await client.query('COMMIT');
      res.status(201).json(created.rows[0]);
    } catch(error) {
      await client.query('ROLLBACK');
      res.status(400).json({error:error.message});
    } finally { client.release(); }
  });

  router.post('/items/:id/notifications/ready', requireDb, async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const itemResult = await client.query(`
        SELECT i.*, o.customer_id, c.discord_user_id, c.discord_handle, c.name AS customer_name
        FROM special_order_items i
        JOIN special_orders o ON o.id=i.special_order_id
        LEFT JOIN customers c ON c.id=o.customer_id
        WHERE i.id=$1
        FOR UPDATE OF i
      `, [req.params.id]);
      const item = itemResult.rows[0];
      if (!item) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Order item not found.' });
      }

      // Hard safeguard: pickup/completion/cancellation always wins over readiness.
      if (['COMPLETED','CANCELLED'].includes(item.status) || item.completed_at || item.cancelled_at) {
        await client.query(`
          UPDATE notifications
          SET status='SUPPRESSED', suppression_reason='Item already picked up/completed before ready notification',
              suppressed_at=now()
          WHERE special_order_item_id=$1 AND status IN ('PENDING','QUEUED')
        `, [req.params.id]);
        await client.query('COMMIT');
        return res.status(409).json({
          error: 'Ready notification suppressed because this item is already picked up/completed.',
          suppressed: true
        });
      }

      if (!['RECEIVED','HELD','CUSTOMER_NOTIFIED'].includes(item.status)) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Item is not in a notification-eligible received/held state.' });
      }

      if (!item.discord_user_id && !item.discord_handle) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Customer has no linked Discord account.' });
      }

      const existing = await client.query(`
        SELECT * FROM notifications
        WHERE special_order_item_id=$1 AND channel='DISCORD_READY'
          AND status IN ('PENDING','QUEUED','SENT')
        ORDER BY created_at DESC LIMIT 1
      `, [req.params.id]);

      if (existing.rows[0]) {
        await client.query('COMMIT');
        return res.json({ alreadyExists: true, notification: existing.rows[0] });
      }

      const created = await client.query(`
        INSERT INTO notifications
          (special_order_item_id,customer_id,channel,recipient,status,message)
        VALUES ($1,$2,'DISCORD_READY',$3,'PENDING',$4)
        RETURNING *
      `, [
        req.params.id,
        item.customer_id,
        item.discord_user_id || item.discord_handle,
        req.body?.message || `Your special order "${item.requested_name}" is ready for pickup at Hobby Corner.`
      ]);

      await client.query('COMMIT');
      res.status(201).json({ notification: created.rows[0] });
    } catch (error) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: error.message });
    } finally {
      client.release();
    }
  });

  router.patch('/items/:id', requireDb, async (req, res) => {
    const quantity = Number(req.body?.quantity);
    if (!Number.isInteger(quantity) || quantity < 1) {
      return res.status(400).json({ error:'quantity must be a positive whole number.' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query(
        'SELECT * FROM special_order_items WHERE id=$1 FOR UPDATE',
        [req.params.id]
      );
      if (!current.rows[0]) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error:'Order item not found.' });
      }
      if (['RECEIVED','HELD','COMPLETED','CANCELLED'].includes(current.rows[0].status)) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error:'This item has progressed too far to change quantity directly.' });
      }

      const supplierLines = await client.query(`
        SELECT soi.id,soi.quantity_received,so.status
        FROM supplier_order_items soi
        JOIN supplier_orders so ON so.id=soi.supplier_order_id
        WHERE soi.special_order_item_id=$1
      `, [req.params.id]);

      const nonDraft = supplierLines.rows.find(x => String(x.status || '').toUpperCase() !== 'DRAFT');
      if (nonDraft) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error:'This item is already on a submitted supplier order. Adjust the supplier order before changing quantity.' });
      }
      const receivedTooHigh = supplierLines.rows.find(x => Number(x.quantity_received || 0) > quantity);
      if (receivedTooHigh) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error:'Quantity cannot be lower than the amount already received.' });
      }

      const updated = await client.query(
        'UPDATE special_order_items SET quantity=$1,updated_at=now() WHERE id=$2 RETURNING *',
        [quantity,req.params.id]
      );
      if (supplierLines.rows.length) {
        await client.query(
          'UPDATE supplier_order_items SET quantity=$1 WHERE special_order_item_id=$2',
          [quantity,req.params.id]
        );
      }
      await client.query('COMMIT');
      res.json(updated.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      res.status(400).json({ error:error.message });
    } finally {
      client.release();
    }
  });

  router.delete('/items/:id', requireDb, async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query(
        'SELECT * FROM special_order_items WHERE id=$1 FOR UPDATE',
        [req.params.id]
      );
      if (!current.rows[0]) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error:'Order item not found.' });
      }
      if (['RECEIVED','HELD','COMPLETED'].includes(current.rows[0].status)) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error:'Received/held/completed items cannot be removed.' });
      }

      const supplierLines = await client.query(`
        SELECT soi.id,so.status
        FROM supplier_order_items soi
        JOIN supplier_orders so ON so.id=soi.supplier_order_id
        WHERE soi.special_order_item_id=$1
      `, [req.params.id]);
      if (supplierLines.rows.length) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error:'This item is already attached to a supplier order. Remove or adjust that supplier-order line first.' });
      }

      await client.query('DELETE FROM special_order_items WHERE id=$1', [req.params.id]);
      await client.query('COMMIT');
      res.json({ ok:true });
    } catch (error) {
      await client.query('ROLLBACK');
      res.status(400).json({ error:error.message });
    } finally {
      client.release();
    }
  });

  router.patch('/items/:id/status', requireDb, async (req, res) => {
    const newStatus = String(req.body?.status || '').toUpperCase();
    if (!VALID_STATUSES.has(newStatus)) return res.status(400).json({ error: 'Invalid status.' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const oldResult = await client.query('SELECT * FROM special_order_items WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!oldResult.rows[0]) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Order item not found.' });
      }
      const old = oldResult.rows[0];
      const stamps = {
        ORDERED: 'ordered_at = COALESCE(ordered_at, now())',
        RECEIVED: 'received_at = COALESCE(received_at, now())',
        HELD: 'held_at = COALESCE(held_at, now())',
        COMPLETED: 'completed_at = COALESCE(completed_at, now())',
        CANCELLED: 'cancelled_at = COALESCE(cancelled_at, now())'
      };
      const stampSql = stamps[newStatus] ? ', ' + stamps[newStatus] : '';
      const updated = await client.query(
        `UPDATE special_order_items SET status=$1, updated_at=now()${stampSql} WHERE id=$2 RETURNING *`,
        [newStatus, req.params.id]
      );
      await client.query(
        'INSERT INTO order_status_history (special_order_item_id,old_status,new_status,note,changed_by) VALUES ($1,$2,$3,$4,$5)',
        [req.params.id, old.status, newStatus, req.body?.note || null, req.body?.changed_by || null]
      );

      if (['COMPLETED','CANCELLED'].includes(newStatus)) {
        await client.query(`
          UPDATE notifications
          SET status='SUPPRESSED',
              suppression_reason=CASE
                WHEN $2='COMPLETED' THEN 'Item picked up/completed before notification was sent'
                ELSE 'Order cancelled before notification was sent'
              END,
              suppressed_at=now()
          WHERE special_order_item_id=$1
            AND status IN ('PENDING','QUEUED')
        `, [req.params.id, newStatus]);
      }

      await client.query('COMMIT');
      res.json(updated.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: error.message });
    } finally {
      client.release();
    }
  });

  router.get('/departments', requireDb, async (req, res) => {
    const { rows } = await pool.query(`
      SELECT d.*, count(sd.supplier_id)::int AS supplier_count
      FROM sourcing_departments d
      LEFT JOIN supplier_sourcing_departments sd ON sd.sourcing_department_id=d.id
      WHERE d.is_active=true
      GROUP BY d.id
      ORDER BY d.name
    `);
    res.json(rows);
  });

  router.get('/departments/:id/suppliers', requireDb, async (req, res) => {
    const productId = req.query.product_id || null;
    const { rows } = await pool.query(`
      SELECT s.id AS supplier_id, s.name, s.supplier_type, s.order_frequency,
             sd.priority AS department_priority,
             sp.id AS supplier_product_id, sp.supplier_sku, sp.supply_price,
             sp.is_orderable, sp.availability_status,
             CASE WHEN sp.id IS NULL THEN false ELSE true END AS exact_product_mapping
      FROM supplier_sourcing_departments sd
      JOIN suppliers s ON s.id=sd.supplier_id AND s.is_active=true
      LEFT JOIN supplier_products sp
        ON sp.supplier_id=s.id
       AND ($2::bigint IS NOT NULL AND sp.product_id=$2::bigint)
      WHERE sd.sourcing_department_id=$1
      ORDER BY
        CASE WHEN sp.id IS NOT NULL THEN 0 ELSE 1 END,
        sd.priority, s.name
    `, [req.params.id, productId]);
    res.json(rows);
  });

  router.post('/departments', requireDb, async (req, res) => {
    const { name, description } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name is required.' });
    const { rows } = await pool.query(`
      INSERT INTO sourcing_departments (name,description)
      VALUES ($1,$2)
      ON CONFLICT (name) DO UPDATE SET description=COALESCE(EXCLUDED.description,sourcing_departments.description)
      RETURNING *
    `, [name, description || null]);
    res.status(201).json(rows[0]);
  });

  router.post('/supplier-departments', requireDb, async (req, res) => {
    const { supplier_id, sourcing_department_id, priority = 1, notes } = req.body || {};
    if (!supplier_id || !sourcing_department_id) return res.status(400).json({ error: 'supplier_id and sourcing_department_id are required.' });
    const { rows } = await pool.query(`
      INSERT INTO supplier_sourcing_departments (supplier_id,sourcing_department_id,priority,notes)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (supplier_id,sourcing_department_id) DO UPDATE SET
        priority=EXCLUDED.priority, notes=COALESCE(EXCLUDED.notes,supplier_sourcing_departments.notes)
      RETURNING *
    `, [supplier_id, sourcing_department_id, priority, notes || null]);
    res.status(201).json(rows[0]);
  });

  router.get('/suppliers', requireDb, async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM suppliers WHERE is_active=true ORDER BY name');
    res.json(rows);
  });

  router.get('/products/:id/recommended-suppliers', requireDb, async (req, res) => {
    const productId = Number(req.params.id);
    if (!Number.isFinite(productId)) return res.status(400).json({ error:'Local product id is required.' });

    const product = await pool.query('SELECT id,product_category FROM products WHERE id=$1', [productId]);
    if (!product.rows[0]) return res.status(404).json({ error:'Product not found.' });
    const categoryText = String(product.rows[0].product_category || '').toLowerCase();

    const { rows } = await pool.query(`
      WITH direct AS (
        SELECT supplier_id, min(priority)::int AS priority
        FROM supplier_products
        WHERE product_id=$1 AND is_orderable=true
        GROUP BY supplier_id
      ),
      product_depts AS (
        SELECT sourcing_department_id
        FROM product_sourcing_departments
        WHERE product_id=$1
      ),
      dept_match AS (
        SELECT ssd.supplier_id, min(ssd.priority)::int AS priority
        FROM supplier_sourcing_departments ssd
        JOIN product_depts pd ON pd.sourcing_department_id=ssd.sourcing_department_id
        GROUP BY ssd.supplier_id
      ),
      category_depts AS (
        SELECT id
        FROM sourcing_departments
        WHERE is_active=true
          AND (
            $2 <> '' AND (
              lower($2) LIKE '%' || lower(name) || '%'
              OR lower(name) LIKE '%' || lower($2) || '%'
            )
          )
      ),
      category_match AS (
        SELECT ssd.supplier_id, min(ssd.priority)::int AS priority
        FROM supplier_sourcing_departments ssd
        JOIN category_depts cd ON cd.id=ssd.sourcing_department_id
        GROUP BY ssd.supplier_id
      )
      SELECT s.*,
             CASE
               WHEN d.supplier_id IS NOT NULL THEN 0
               WHEN dm.supplier_id IS NOT NULL THEN 1
               WHEN cm.supplier_id IS NOT NULL THEN 2
               ELSE 3
             END AS recommendation_rank,
             COALESCE(d.priority,dm.priority,cm.priority,9999) AS recommendation_priority,
             CASE
               WHEN d.supplier_id IS NOT NULL THEN 'Exact product supplier'
               WHEN dm.supplier_id IS NOT NULL THEN 'Product department supplier'
               WHEN cm.supplier_id IS NOT NULL THEN 'Category supplier'
               ELSE NULL
             END AS recommendation_reason
      FROM suppliers s
      LEFT JOIN direct d ON d.supplier_id=s.id
      LEFT JOIN dept_match dm ON dm.supplier_id=s.id
      LEFT JOIN category_match cm ON cm.supplier_id=s.id
      WHERE s.is_active=true
      ORDER BY recommendation_rank,recommendation_priority,s.name
    `, [productId, categoryText]);

    res.json(rows);
  });

  router.post('/suppliers', requireDb, async (req, res) => {
    const { name, supplier_type, order_frequency, lightspeed_supplier_id, notes } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name is required.' });
    const { rows } = await pool.query(`
      INSERT INTO suppliers (name,supplier_type,order_frequency,lightspeed_supplier_id,notes)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (name) DO UPDATE SET supplier_type=EXCLUDED.supplier_type,
        order_frequency=EXCLUDED.order_frequency,
        lightspeed_supplier_id=COALESCE(EXCLUDED.lightspeed_supplier_id,suppliers.lightspeed_supplier_id),
        notes=COALESCE(EXCLUDED.notes,suppliers.notes), updated_at=now()
      RETURNING *
    `, [name, supplier_type || null, order_frequency || null, lightspeed_supplier_id || null, notes || null]);
    res.status(201).json(rows[0]);
  });

  router.post('/supplier-products', requireDb, async (req, res) => {
    const { supplier_id, product_id, supplier_sku, supplier_description, manufacturer_text,
      order_channel = 'TRADE', order_url = null,
      supply_price, priority = 1, is_orderable = true, notes } = req.body || {};
    if (!supplier_id || !product_id) return res.status(400).json({ error: 'supplier_id and product_id are required.' });
    const { rows } = await pool.query(`
      INSERT INTO supplier_products
        (supplier_id,product_id,supplier_sku,supplier_description,manufacturer_text,order_channel,order_url,supply_price,priority,is_orderable,notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (supplier_id,product_id) DO UPDATE SET
        supplier_sku=EXCLUDED.supplier_sku,
        supplier_description=COALESCE(EXCLUDED.supplier_description,supplier_products.supplier_description),
        manufacturer_text=COALESCE(EXCLUDED.manufacturer_text,supplier_products.manufacturer_text),
        order_channel=EXCLUDED.order_channel,
        order_url=COALESCE(EXCLUDED.order_url,supplier_products.order_url),
        supply_price=EXCLUDED.supply_price, priority=EXCLUDED.priority, is_orderable=EXCLUDED.is_orderable,
        notes=EXCLUDED.notes
      RETURNING *
    `, [supplier_id, product_id, supplier_sku || null, supplier_description || null, manufacturer_text || null,
        String(order_channel || 'TRADE').toUpperCase(), order_url || null,
        supply_price || null, priority, Boolean(is_orderable), notes || null]);
    res.status(201).json(rows[0]);
  });

  router.get('/suppliers/:id/orderable', requireDb, async (req, res) => {
    const { rows } = await pool.query(`
      SELECT p.id AS product_id, p.name, p.sku, p.upc, sp.supplier_sku, sp.supply_price, sp.priority,
             sum(CASE WHEN i.status IN ('OOS','READY_TO_ORDER') THEN i.quantity ELSE 0 END)::int AS qty_needed,
             count(i.id) FILTER (WHERE i.status IN ('OOS','READY_TO_ORDER'))::int AS waiting_orders
      FROM supplier_products sp
      JOIN products p ON p.id=sp.product_id
      LEFT JOIN special_order_items i ON i.product_id=p.id
      WHERE sp.supplier_id=$1 AND sp.is_orderable=true
      GROUP BY p.id,p.name,p.sku,p.upc,sp.supplier_sku,sp.supply_price,sp.priority
      HAVING sum(CASE WHEN i.status IN ('OOS','READY_TO_ORDER') THEN i.quantity ELSE 0 END) > 0
      ORDER BY sp.priority, p.name
    `, [req.params.id]);
    res.json(rows);
  });


  router.patch('/items/:id/source-link', requireDb, async (req, res) => {
    const sourceUrl = req.body?.source_url || null;
    const supplierId = req.body?.supplier_id || null;
    if (sourceUrl) {
      try {
        const u = new URL(sourceUrl);
        if (!['http:','https:'].includes(u.protocol)) throw new Error();
      } catch {
        return res.status(400).json({ error:'source_url must be a valid http(s) URL.' });
      }
    }

    const item = await pool.query(
      'UPDATE special_order_items SET source_url=$1, updated_at=now() WHERE id=$2 RETURNING *',
      [sourceUrl, req.params.id]
    );
    if (!item.rows[0]) return res.status(404).json({ error:'Special-order item not found.' });

    if (supplierId) {
      await pool.query(`
        INSERT INTO special_order_item_suppliers
          (special_order_item_id,supplier_id,priority,source_url)
        VALUES ($1,$2,1,$3)
        ON CONFLICT (special_order_item_id,supplier_id) DO UPDATE SET source_url=EXCLUDED.source_url
      `, [req.params.id, supplierId, sourceUrl]);
    }
    res.json(item.rows[0]);
  });

  router.patch('/supplier-order-items/:id/source-link', requireDb, async (req, res) => {
    const sourceUrl = req.body?.source_url || null;
    if (sourceUrl) {
      try {
        const u = new URL(sourceUrl);
        if (!['http:','https:'].includes(u.protocol)) throw new Error();
      } catch {
        return res.status(400).json({ error:'source_url must be a valid http(s) URL.' });
      }
    }
    const updated = await pool.query(
      'UPDATE supplier_order_items SET source_url=$1 WHERE id=$2 RETURNING *',
      [sourceUrl, req.params.id]
    );
    if (!updated.rows[0]) return res.status(404).json({ error:'Supplier-order item not found.' });
    res.json(updated.rows[0]);
  });

  router.post('/supplier-orders', requireDb, async (req, res) => {
    const { supplier_id, items = [], notes = null, created_by = null, supplier_order_number = null } = req.body || {};
    if (!supplier_id) return res.status(400).json({ error: 'supplier_id is required.' });
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'At least one item is required.' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const supplierResult = await client.query('SELECT * FROM suppliers WHERE id=$1', [supplier_id]);
      const supplier = supplierResult.rows[0];
      if (!supplier) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Supplier not found.' });
      }

      const order = await client.query(`
        INSERT INTO supplier_orders
          (supplier_id,status,supplier_order_number,notes,created_by,lightspeed_sync_status)
        VALUES ($1,'DRAFT',$2,$3,$4,'LOCAL_ONLY')
        RETURNING *
      `, [supplier_id, supplier_order_number, notes, created_by]);

      for (const item of items) {
        const qty = Number(item.quantity || 0);
        if (qty <= 0) continue;
        if (!item.product_id && !item.placeholder_name) continue;
        const specialQty = Math.max(0, Number(item.special_order_quantity || 0));
        const floorQty = Math.max(0, Number(item.floor_quantity ?? (qty - specialQty)));
        await client.query(`
          INSERT INTO supplier_order_items
            (supplier_order_id,product_id,supplier_product_id,quantity,unit_cost,
             special_order_item_id,special_order_quantity,floor_quantity,
             placeholder_name,placeholder_sku,source_url)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        `, [order.rows[0].id, item.product_id || null, item.supplier_product_id || null, qty,
             item.unit_cost || null, item.special_order_item_id || null, specialQty, floorQty,
             item.placeholder_name || null, item.placeholder_sku || null, item.source_url || null]);
      }

      await client.query('COMMIT');
      res.status(201).json({ order: order.rows[0], liveMode: Boolean(liveMode) });
    } catch (error) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: error.message });
    } finally {
      client.release();
    }
  });

  router.get('/supplier-orders/:id', requireDb, async (req, res) => {
    const order = await pool.query(`
      SELECT so.*, s.name AS supplier_name, s.lightspeed_supplier_id
      FROM supplier_orders so JOIN suppliers s ON s.id=so.supplier_id
      WHERE so.id=$1
    `, [req.params.id]);
    if (!order.rows[0]) return res.status(404).json({ error:'Supplier order not found.' });
    const items = await pool.query(`
      SELECT soi.*, COALESCE(p.name,soi.placeholder_name) AS name,
             COALESCE(p.sku,soi.placeholder_sku) AS sku,
             p.lightspeed_product_id, sp.supplier_sku
      FROM supplier_order_items soi
      LEFT JOIN products p ON p.id=soi.product_id
      LEFT JOIN supplier_products sp ON sp.id=soi.supplier_product_id
      WHERE soi.supplier_order_id=$1
      ORDER BY p.name
    `, [req.params.id]);
    res.json({ order:order.rows[0], items:items.rows });
  });

  router.post('/supplier-orders/:id/push-lightspeed', requireDb, async (req, res) => {
    if (!liveMode) return res.status(423).json({ error:'Lightspeed writes are disabled in setup mode.' });
    if (!lightspeedOutletId) return res.status(503).json({ error:'LIGHTSPEED_OUTLET_ID is not configured.' });

    const orderResult = await pool.query(`
      SELECT so.*, s.name AS supplier_name, s.lightspeed_supplier_id
      FROM supplier_orders so JOIN suppliers s ON s.id=so.supplier_id
      WHERE so.id=$1
    `, [req.params.id]);
    const order = orderResult.rows[0];
    if (!order) return res.status(404).json({ error:'Supplier order not found.' });

    const itemsResult = await pool.query(`
      SELECT soi.*, p.lightspeed_product_id
      FROM supplier_order_items soi JOIN products p ON p.id=soi.product_id
      WHERE soi.supplier_order_id=$1
    `, [req.params.id]);
    const missing = itemsResult.rows.filter(x => !x.lightspeed_product_id);
    if (missing.length) return res.status(409).json({
      error:'One or more supplier-order lines are placeholders and must be completed as Lightspeed products before this PO can be pushed to Lightspeed.',
      placeholder_line_ids: missing.map(x => x.id)
    });

    try {
      const payload = {
        data: {
          name: order.notes || `Hobby Corner special-order PO — ${order.supplier_name}`,
          outlet_id: lightspeedOutletId,
          type: 'SUPPLIER',
          status: 'OPEN'
        }
      };
      if (order.lightspeed_supplier_id) payload.data.supplier_id = order.lightspeed_supplier_id;
      const created = await lightspeedFetch(lightspeedDomain, lightspeedToken, '/consignments', {
        method:'POST', body:JSON.stringify(payload)
      });
      const consignment = created?.data || created;

      const bulk = itemsResult.rows.map(x => ({
        product_id:x.lightspeed_product_id,
        count:Number(x.quantity),
        ...(x.unit_cost != null ? { cost:Number(x.unit_cost) } : {})
      }));
      await lightspeedFetch(lightspeedDomain, lightspeedToken, `/consignments/${consignment.id}/bulk`, {
        method:'POST', body:JSON.stringify({ data: bulk })
      });

      const updated = await pool.query(`
        UPDATE supplier_orders
        SET lightspeed_consignment_id=$1, lightspeed_sync_status='SYNCED', updated_at=now()
        WHERE id=$2 RETURNING *
      `, [consignment.id, req.params.id]);
      res.json({ order:updated.rows[0], lightspeed:consignment });
    } catch (error) {
      await pool.query(`
        UPDATE supplier_orders SET lightspeed_sync_status='ERROR', updated_at=now() WHERE id=$1
      `, [req.params.id]);
      res.status(error.status || 502).json({ error:error.message });
    }
  });

  router.post('/supplier-orders/:id/receive', requireDb, async (req, res) => {
    const { items = [], received_by = null, notes = null } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error:'Received items are required.' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const orderResult = await client.query('SELECT * FROM supplier_orders WHERE id=$1 FOR UPDATE', [req.params.id]);
      const order = orderResult.rows[0];
      if (!order) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error:'Supplier order not found.' });
      }

      const outcomes = [];
      for (const incoming of items) {
        const lineResult = await client.query(`
          SELECT soi.*, p.name
          FROM supplier_order_items soi JOIN products p ON p.id=soi.product_id
          WHERE soi.id=$1 AND soi.supplier_order_id=$2 FOR UPDATE OF soi
        `, [incoming.supplier_order_item_id, req.params.id]);
        const line = lineResult.rows[0];
        if (!line) continue;
        const qty = Math.max(0, Number(incoming.received_quantity || 0));
        if (qty <= 0) continue;

        await client.query(`
          UPDATE supplier_order_items
          SET quantity_received=quantity_received+$1
          WHERE id=$2
        `, [qty, line.id]);
        await client.query(`
          INSERT INTO receiving_events
            (supplier_order_id,supplier_order_item_id,product_id,quantity_received,received_by,notes)
          VALUES ($1,$2,$3,$4,$5,$6)
        `, [req.params.id, line.id, line.product_id, qty, received_by, notes]);

        let remaining = qty;
        const waiting = await client.query(`
          SELECT i.id, i.quantity, o.customer_id
          FROM special_order_items i
          JOIN special_orders o ON o.id=i.special_order_id
          WHERE i.product_id=$1
            AND i.status IN ('ORDERED','BACKORDERED','OOS','READY_TO_ORDER')
          ORDER BY i.created_at, i.id
          FOR UPDATE OF i
        `, [line.product_id]);

        const allocated = [];
        for (const so of waiting.rows) {
          if (remaining <= 0) break;
          const existingAlloc = await client.query(`
            SELECT COALESCE(sum(quantity),0)::int AS qty
            FROM inventory_allocations
            WHERE special_order_item_id=$1 AND released_at IS NULL
          `, [so.id]);
          const needed = Math.max(0, Number(so.quantity) - Number(existingAlloc.rows[0].qty || 0));
          if (needed <= 0) continue;
          const give = Math.min(needed, remaining);
          await client.query(`
            INSERT INTO inventory_allocations (special_order_item_id,product_id,quantity)
            VALUES ($1,$2,$3)
          `, [so.id, line.product_id, give]);
          if (give >= needed) {
            await client.query(`
              UPDATE special_order_items
              SET status='RECEIVED', received_at=COALESCE(received_at,now()), updated_at=now()
              WHERE id=$1
            `, [so.id]);
            await client.query(`
              INSERT INTO order_status_history (special_order_item_id,old_status,new_status,note,changed_by)
              VALUES ($1,NULL,'RECEIVED','Allocated during receiving',$2)
            `, [so.id, received_by]);
          }
          allocated.push({ special_order_item_id:so.id, quantity:give });
          remaining -= give;
        }

        outcomes.push({ supplier_order_item_id:line.id, product:line.name, received:qty, allocated, floor_remaining:remaining });
      }

      await client.query(`
        UPDATE supplier_orders SET status='RECEIVING', updated_at=now() WHERE id=$1
      `, [req.params.id]);
      await client.query('COMMIT');
      res.json({ order_id:req.params.id, outcomes });
    } catch (error) {
      await client.query('ROLLBACK');
      res.status(400).json({ error:error.message });
    } finally { client.release(); }
  });

  router.get('/notifications/queue', requireDb, async (req, res) => {
    const { rows } = await pool.query(`
      SELECT n.*, c.name AS customer_name, i.requested_name, i.status AS item_status
      FROM notifications n
      LEFT JOIN customers c ON c.id=n.customer_id
      LEFT JOIN special_order_items i ON i.id=n.special_order_item_id
      WHERE n.status IN ('PENDING','QUEUED')
      ORDER BY n.created_at
      LIMIT 500
    `);
    res.json(rows);
  });

  router.get('/customers/search', async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json([]);
    const candidates = [];
    const params = new URLSearchParams({ type: 'customers', page_size: '20' });
    if (q.includes('@')) params.set('email', q);
    else if (/^[+()\d\s.-]{7,}$/.test(q)) params.set('phone', q);
    else {
      const bits = q.split(/\s+/).filter(Boolean);
      params.set('first_name', bits[0]);
      if (bits.length > 1) params.set('last_name', bits.slice(1).join(' '));
    }
    try {
      const response = await fetch(`https://${lightspeedDomain}.retail.lightspeed.app/api/2026-04/search?${params.toString()}`, {
        headers: lightspeedHeaders(lightspeedToken)
      });
      const text = await response.text();
      const body = text ? JSON.parse(text) : {};
      if (!response.ok) throw new Error(`Lightspeed ${response.status}: ${text}`);
      for (const c of (body.data || [])) candidates.push(c);

      if (pool && candidates.length) {
        const ids = candidates.map(c => String(c.id || '')).filter(Boolean);
        if (ids.length) {
          const local = await pool.query(
            'SELECT * FROM customers WHERE lightspeed_customer_id = ANY($1::text[])',
            [ids]
          );
          const byLightspeedId = new Map(local.rows.map(c => [String(c.lightspeed_customer_id), c]));
          for (const c of candidates) {
            const saved = byLightspeedId.get(String(c.id || ''));
            if (!saved) continue;
            c.local_customer_id = saved.id;
            c.discord_handle = saved.discord_handle || null;
            c.special_orders_phone = saved.phone || null;
            c.special_orders_notes = saved.notes || null;
          }
        }
      }
      res.json(candidates);
    } catch (error) {
      res.status(502).json({ error: error.message });
    }
  });

  router.post('/customers/create-lightspeed', requireDb, async (req, res) => {
    const body = req.body || {};
    const firstName = String(body.first_name || '').trim();
    const lastName = String(body.last_name || '').trim();
    if (!firstName) return res.status(400).json({ error:'First name is required.' });
    if (!lastName) return res.status(400).json({ error:'Last name is required.' });

    const payload = {
      first_name:firstName,
      last_name:lastName,
      email:body.email || null,
      mobile:body.phone || null,
      note:body.lightspeed_note || null
    };

    try {
      const created = await lightspeedVersionedFetch(
        lightspeedDomain,
        lightspeedToken,
        '/customers',
        { method:'POST', body:JSON.stringify(payload) },
        '2026-01'
      );
      const customer = created?.data || created;
      if (!customer?.id) throw new Error('Lightspeed did not return a customer id.');

      const name = [customer.first_name || firstName, customer.last_name || lastName].filter(Boolean).join(' ');
      const { rows } = await pool.query(`
        INSERT INTO customers
          (lightspeed_customer_id,name,phone,email,discord_handle,notes,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,now())
        ON CONFLICT (lightspeed_customer_id) DO UPDATE SET
          name=EXCLUDED.name,
          phone=EXCLUDED.phone,
          email=EXCLUDED.email,
          discord_handle=EXCLUDED.discord_handle,
          notes=EXCLUDED.notes,
          updated_at=now()
        RETURNING *
      `, [
        customer.id,
        name,
        body.phone || customer.mobile || customer.phone || null,
        body.email || customer.email || null,
        body.discord_handle || null,
        body.notes || null
      ]);

      res.status(201).json({ lightspeed:customer, local:rows[0] });
    } catch (error) {
      res.status(error.status || 502).json({ error:error.message });
    }
  });

  router.get('/customers/:lightspeedId/profile', requireDb, async (req, res) => {
    const { rows } = await pool.query(
      'SELECT * FROM customers WHERE lightspeed_customer_id=$1 LIMIT 1',
      [req.params.lightspeedId]
    );
    res.json(rows[0] || null);
  });

  router.patch('/customers/:lightspeedId/profile', requireDb, async (req, res) => {
    const body = req.body || {};
    const lightspeedId = String(req.params.lightspeedId || '').trim();
    if (!lightspeedId) return res.status(400).json({ error:'Lightspeed customer id is required.' });

    const firstName = String(body.first_name || '').trim();
    const lastName = String(body.last_name || '').trim();
    const companyName = String(body.company_name || '').trim() || null;
    const name = String(body.name || [firstName,lastName].filter(Boolean).join(' ') || companyName || '').trim();
    if (!name) return res.status(400).json({ error:'Customer name is required.' });

    let lightspeedWarning = null;
    let lightspeedCustomer = null;
    if (body.sync_lightspeed === true) {
      try {
        const updatePayload = {
          first_name: firstName || null,
          last_name: lastName || null,
          company_name: companyName,
          email: body.email || null,
          phone: body.phone || null,
          mobile: body.mobile || body.phone || null,
          physical_address_1: body.address_line_1 || null,
          physical_address_2: body.address_line_2 || null,
          physical_city: body.city || null,
          physical_state: body.state || null,
          physical_postcode: body.postcode || null,
          physical_country_id: body.country_code || null
        };

        const updated = await lightspeedVersionedFetch(
          lightspeedDomain,
          lightspeedToken,
          '/customers/' + encodeURIComponent(lightspeedId),
          { method:'PUT', body:JSON.stringify(updatePayload) },
          '2026-07'
        );
        lightspeedCustomer = updated?.data || updated;
      } catch (error) {
        lightspeedWarning = error.message;
      }
    }

    const { rows } = await pool.query(`
      INSERT INTO customers
        (lightspeed_customer_id,name,phone,email,discord_handle,notes,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,now())
      ON CONFLICT (lightspeed_customer_id) DO UPDATE SET
        name=EXCLUDED.name,
        phone=EXCLUDED.phone,
        email=EXCLUDED.email,
        discord_handle=EXCLUDED.discord_handle,
        notes=EXCLUDED.notes,
        updated_at=now()
      RETURNING *
    `, [
      lightspeedId,
      name,
      body.phone || body.mobile || null,
      body.email || null,
      body.discord_handle || null,
      body.notes || null
    ]);

    res.json({ customer:rows[0], lightspeed:lightspeedCustomer, lightspeed_warning:lightspeedWarning });
  });

  router.post('/address/verify-usps', async (req, res) => {
    try {
      res.json(await verifyUspsAddress(req.body || {}));
    } catch (error) {
      res.status(error.status || 502).json({ error:error.message });
    }
  });

  router.get('/products/:id/inventory', async (req, res) => {
    try {
      const response = await fetch(`https://${lightspeedDomain}.retail.lightspeed.app/api/2026-04/inventory/${encodeURIComponent(req.params.id)}`, {
        headers: lightspeedHeaders(lightspeedToken)
      });
      const text = await response.text();
      const body = text ? JSON.parse(text) : {};
      if (!response.ok) throw new Error(`Lightspeed ${response.status}: ${text}`);
      res.json(body);
    } catch (error) {
      res.status(502).json({ error: error.message });
    }
  });

  router.post('/products/registry-upsert', requireDb, async (req, res) => {
    const body = req.body || {};
    if (!body.lightspeed_product_id) return res.status(400).json({ error:'lightspeed_product_id is required.' });
    if (!body.name) return res.status(400).json({ error:'name is required.' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const product = await client.query(`
        INSERT INTO products
          (lightspeed_product_id,name,sku,upc,description,brand,product_category,last_lightspeed_sync_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,now(),now())
        ON CONFLICT (lightspeed_product_id) DO UPDATE SET
          name=EXCLUDED.name,
          sku=COALESCE(EXCLUDED.sku,products.sku),
          upc=COALESCE(EXCLUDED.upc,products.upc),
          description=COALESCE(EXCLUDED.description,products.description),
          brand=COALESCE(EXCLUDED.brand,products.brand),
          product_category=COALESCE(EXCLUDED.product_category,products.product_category),
          last_lightspeed_sync_at=now(),
          updated_at=now()
        RETURNING *
      `, [
        body.lightspeed_product_id,body.name,body.sku||null,body.upc||null,
        body.description||null,body.brand||null,body.product_category||null
      ]);

      const identifiers = Array.isArray(body.identifiers) ? [...body.identifiers] : [];
      if (body.sku) identifiers.push({type:'SKU',value:body.sku,is_primary:true});
      if (body.upc) identifiers.push({type:'UPC',value:body.upc});
      if (body.isbn) identifiers.push({type:'ISBN',value:body.isbn});
      for (const value of (Array.isArray(body.other_codes) ? body.other_codes : [])) {
        if (value) identifiers.push({type:'OTHER',value});
      }

      await upsertProductIdentifiers(client, product.rows[0].id, identifiers, body.source || 'importer');
      await client.query('COMMIT');

      const ids = await pool.query(`
        SELECT identifier_type,identifier_value,source,supplier_id,is_primary
        FROM product_identifiers WHERE product_id=$1
        ORDER BY identifier_type,identifier_value
      `, [product.rows[0].id]);

      res.json({ product:product.rows[0], identifiers:ids.rows });
    } catch(error) {
      await client.query('ROLLBACK');
      res.status(400).json({error:error.message});
    } finally { client.release(); }
  });

  registerSpecialOrderProductRoutes(router, {
    pool: {
      query: (...args) => {
        if (!pool) throw Object.assign(new Error('Special-order database is not configured yet.'), { status:503 });
        return pool.query(...args);
      },
      connect: (...args) => {
        if (!pool) throw Object.assign(new Error('Special-order database is not configured yet.'), { status:503 });
        return pool.connect(...args);
      }
    },
    requireDb,
    lightspeedDomain,
    lightspeedToken,
    liveMode,
    allowProductWrites,
    lightspeedVersionedFetch,
    lightspeedFetch,
    ensureLightspeedTag,
    uploadLightspeedImageFromUrl,
    upsertLocalProduct,
    upsertProductIdentifiers,
    matchTokens,
    scorePotentialMatch
  });

  return router;
}
