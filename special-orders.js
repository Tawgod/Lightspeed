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
  if (!pool || !product || !product.id) return null;
  const productName=String(product.name || '').trim();
  if (!productName) {
    console.warn('[special-orders] skipped partial Lightspeed product upsert with no name', {
      id:product.id,
      sku:product.sku || null
    });
    return null;
  }
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
    [product.id, productName, product.sku || null, upc,
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
  lightspeedOutletId = null,
  discordToken = null,
  gwPreorderChannelId = null,
  gwAutoSubmitAlertChannelId = null,
  gwAutoSubmitAlertRoleId = null
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
      allowProductWrites: Boolean(allowProductWrites),
      gwDiscordConfigured: Boolean(discordToken && gwPreorderChannelId)
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

  router.post('/preorders/discord-watch', requireDb, async (req,res)=>{
    const body=req.body||{};
    const itemText=String(body.item_text||'').trim();
    const sourceKey=String(body.source_key||'').trim();
    const captureMode=String(body.capture_mode||'INFORMAL').trim().toUpperCase();
    if(!itemText)return res.status(400).json({error:'item_text is required.'});
    if(!sourceKey)return res.status(400).json({error:'source_key is required.'});
    if(!['INFORMAL','FORMAL','STAFF'].includes(captureMode))return res.status(400).json({error:'Invalid capture_mode.'});

    const discordUserId=String(body.discord_user_id||'').trim()||null;
    let customerId=null;
    if(discordUserId){
      const customer=await pool.query(
        'SELECT id FROM customers WHERE discord_user_id=$1 ORDER BY updated_at DESC LIMIT 1',
        [discordUserId]
      );
      customerId=customer.rows[0]?.id||null;
    }
    const confidence=body.confidence==null?null:Math.max(0,Math.min(1,Number(body.confidence)||0));
    const sql=
      "INSERT INTO preorder_watch_items "+
      "(customer_id,discord_user_id,discord_username,discord_display_name,capture_mode,status,item_text,message_text,guild_id,channel_id,channel_name,message_id,message_url,source_key,confidence,notes) "+
      "VALUES ($1,$2,$3,$4,$5,'WATCHING',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) "+
      "ON CONFLICT (source_key) DO UPDATE SET "+
      "customer_id=COALESCE(preorder_watch_items.customer_id,EXCLUDED.customer_id),"+
      "discord_username=COALESCE(EXCLUDED.discord_username,preorder_watch_items.discord_username),"+
      "discord_display_name=COALESCE(EXCLUDED.discord_display_name,preorder_watch_items.discord_display_name),"+
      "capture_mode=CASE "+
        "WHEN EXCLUDED.capture_mode='STAFF' THEN 'STAFF' "+
        "WHEN EXCLUDED.capture_mode='FORMAL' AND preorder_watch_items.capture_mode='INFORMAL' THEN 'FORMAL' "+
        "ELSE preorder_watch_items.capture_mode END,"+
      "item_text=EXCLUDED.item_text,message_text=COALESCE(EXCLUDED.message_text,preorder_watch_items.message_text),"+
      "message_url=COALESCE(EXCLUDED.message_url,preorder_watch_items.message_url),"+
      "confidence=COALESCE(EXCLUDED.confidence,preorder_watch_items.confidence),updated_at=now() "+
      "RETURNING *";
    const {rows}=await pool.query(sql,[
      customerId,discordUserId,body.discord_username||null,body.discord_display_name||null,captureMode,
      itemText,body.message_text||null,body.guild_id||null,body.channel_id||null,body.channel_name||null,
      body.message_id||null,body.message_url||null,sourceKey,confidence,body.notes||null
    ]);
    res.status(201).json({watch:rows[0],matched_customer:Boolean(customerId)});
  });

  router.get('/preorders/discord-watch', requireDb, async (req,res)=>{
    const status=String(req.query.status||'WATCHING').trim().toUpperCase();
    const params=[];
    let where='';
    if(status!=='ALL'){
      if(!['WATCHING','AVAILABLE','CONVERTED','DISMISSED'].includes(status))return res.status(400).json({error:'Invalid status filter.'});
      params.push(status);
      where='WHERE w.status=$1';
    }
    const sql=
      "SELECT w.*,c.name AS customer_name,c.phone AS customer_phone,c.email AS customer_email,"+
      "p.name AS product_name,p.sku AS product_sku,p.upc AS product_upc "+
      "FROM preorder_watch_items w "+
      "LEFT JOIN customers c ON c.id=w.customer_id "+
      "LEFT JOIN products p ON p.id=w.product_id "+where+
      " ORDER BY CASE w.status WHEN 'WATCHING' THEN 0 WHEN 'AVAILABLE' THEN 1 WHEN 'CONVERTED' THEN 2 ELSE 3 END,w.captured_at DESC";
    const {rows}=await pool.query(sql,params);
    res.json(rows);
  });

  router.patch('/preorders/discord-watch/:id', requireDb, async (req,res)=>{
    const body=req.body||{};
    const current=await pool.query('SELECT * FROM preorder_watch_items WHERE id=$1',[req.params.id]);
    if(!current.rows[0])return res.status(404).json({error:'Preorder watch item not found.'});
    const old=current.rows[0];
    const status=body.status===undefined?old.status:String(body.status||'').trim().toUpperCase();
    if(!['WATCHING','AVAILABLE','CONVERTED','DISMISSED'].includes(status))return res.status(400).json({error:'Invalid status.'});
    const itemText=body.item_text===undefined?old.item_text:String(body.item_text||'').trim();
    if(!itemText)return res.status(400).json({error:'item_text cannot be blank.'});
    const notes=body.notes===undefined?old.notes:(String(body.notes||'').trim()||null);
    const productId=body.product_id===undefined?old.product_id:(body.product_id||null);
    const {rows}=await pool.query(
      'UPDATE preorder_watch_items SET status=$1,item_text=$2,notes=$3,product_id=$4,updated_at=now() WHERE id=$5 RETURNING *',
      [status,itemText,notes,productId,req.params.id]
    );
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
    const params=[];
    const where=[];
    if(req.query.type){
      params.push(String(req.query.type).toUpperCase());
      where.push(`pc.campaign_type=$${params.length}`);
    }
    const { rows } = await pool.query(`
      SELECT pc.*,
             count(DISTINCT pp.id)::int AS product_count,
             count(DISTINCT pr.id)::int AS request_count
      FROM preorder_campaigns pc
      LEFT JOIN preorder_products pp ON pp.preorder_campaign_id=pc.id
      LEFT JOIN preorder_requests pr ON pr.preorder_product_id=pp.id
      ${where.length?'WHERE '+where.join(' AND '):''}
      GROUP BY pc.id
      ORDER BY COALESCE(pc.order_due_at,pc.release_date::timestamptz,TIMESTAMPTZ '9999-12-31'), pc.created_at DESC
    `,params);
    res.json(rows);
  });


  function gwHtmlText(value=''){
    return String(value)
      .replace(/<br\s*\/?>/gi,' ')
      .replace(/&nbsp;/gi,' ')
      .replace(/&amp;/gi,'&')
      .replace(/&quot;/gi,'"')
      .replace(/&#39;|&apos;/gi,"'")
      .replace(/&lt;/gi,'<')
      .replace(/&gt;/gi,'>')
      .replace(/<[^>]+>/g,' ')
      .replace(/\s+/g,' ')
      .trim();
  }

  function parseGwMoney(label,text){
    const re=new RegExp('(?:'+label+')\\s*[:\\-]?\\s*\\$?\\s*(\\d+(?:\\.\\d{1,2})?)','i');
    const m=String(text||'').match(re);
    return m?Number(m[1]):null;
  }

  function parseGwListing(name='',description=''){
    const sourceName=String(name||'').replace(/\s+/g,' ').trim();
    const desc=String(description||'').replace(/\s+/g,' ').trim();
    const text=(sourceName+' '+desc).trim();
    const lower=text.toLowerCase();
    const reasons=[];
    const french=/\b(french|français|francais|version française|version francaise|québec|quebec)\b/i.test(text);
    const fixture=/\b(fixture|display|rack|stockist|assortment|range\s+set|launch\s+set|paint\s+range|counter\s+unit|floor\s+stand)\b/i.test(lower);
    const packMatch=text.match(/\(\s*x\s*(\d+)\s*\)|\b(\d+)\s*[- ]?pack\b|\bpack\s+of\s+(\d+)\b|\bcase\s+of\s+(\d+)\b/i);
    const casePackSize=Number(packMatch?.[1]||packMatch?.[2]||packMatch?.[3]||packMatch?.[4]||0)||null;
    let shortCode=null;
    const codeMatch=text.match(/\b(?:short\s*code|product\s*code|code|sku)\s*[:#-]?\s*([A-Z0-9][A-Z0-9_-]{2,20})\b/i);
    if(codeMatch)shortCode=codeMatch[1].toUpperCase();
    let msrp=parseGwMoney('(?:MSRP|RRP|RETAIL(?:\\s+PRICE)?)',text);
    let cost=parseGwMoney('(?:COST|TRADE(?:\\s+PRICE)?|NET)',text);
    const money=[...text.matchAll(/\$(\d+(?:\.\d{1,2})?)/g)].map(m=>Number(m[1])).filter(Number.isFinite);
    if(msrp==null && money.length)msrp=money[0];
    if(cost==null && money.length>1)cost=money[1];
    let itemDescription=sourceName
      .replace(/\b(?:short\s*code|product\s*code|code|sku)\s*[:#-]?\s*[A-Z0-9][A-Z0-9_-]{2,20}\b/ig,'')
      .replace(/\b(?:MSRP|RRP|RETAIL(?:\s+PRICE)?|COST|TRADE(?:\s+PRICE)?|NET)\s*[:\-]?\s*\$?\s*\d+(?:\.\d{1,2})?/ig,'')
      .replace(/\s*[|•·]\s*[|•·\s]*/g,' ')
      .replace(/\s{2,}/g,' ')
      .trim()||sourceName;
    let suggestedSingleName=null;
    let suggestedSingleMsrp=null;
    if(casePackSize && casePackSize>1){
      suggestedSingleName=itemDescription
        .replace(/\(\s*x\s*\d+\s*\)/ig,'')
        .replace(/\b\d+\s*[- ]?pack\b/ig,'')
        .replace(/\bpack\s+of\s+\d+\b/ig,'')
        .replace(/\bcase\s+of\s+\d+\b/ig,'')
        .replace(/\s{2,}/g,' ').trim()||itemDescription;
      if(msrp!=null)suggestedSingleMsrp=Math.round((msrp/casePackSize)*100)/100;
      reasons.push('Case pack x'+casePackSize+' — review suggested single-item name/price before posting');
    }
    if(french)reasons.push('French / Québec product');
    if(fixture)reasons.push('Fixture / retailer display material');
    const postEnabled=!(french||fixture||casePackSize);
    return {
      item_description:itemDescription,source_item_description:sourceName,short_code:shortCode,msrp,cost,
      post_enabled:postEnabled,case_pack_size:casePackSize,suggested_single_name:suggestedSingleName,
      suggested_single_msrp:suggestedSingleMsrp,reasons,
      disposition:postEnabled?'POST_AS_IS':(french||fixture?'DO_NOT_POST':'REVIEW')
    };
  }
  function walkGwFormData(node,out,seen,depth=0){
    if(depth>14||node==null)return;
    if(Array.isArray(node)){
      // Google Forms question records commonly contain numeric id, title, type and nested entry/options.
      const id=(typeof node[0]==='number'||typeof node[0]==='string')?node[0]:null;
      const title=typeof node[1]==='string'?gwHtmlText(node[1]):'';
      const desc=typeof node[2]==='string'?gwHtmlText(node[2]):'';
      const type=typeof node[3]==='number'?node[3]:null;
      if(id!=null && title && type!=null && Array.isArray(node[4]) && title.length<500){
        const key=String(id)+'|'+title;
        if(!seen.has(key)){
          const options=[];
          const images=[];
          const collect=(x,d=0)=>{
            if(d>7||x==null)return;
            if(typeof x==='string'){
              const raw=x.replace(/\\u0026/g,'&').replace(/\\\//g,'/');
              if(/^https:\/\//i.test(raw) &&
                 (/googleusercontent\.com/i.test(raw)||/\.(?:png|jpe?g|webp)(?:\?|$)/i.test(raw))){
                if(!images.includes(raw))images.push(raw);
              }
              return;
            }
            if(Array.isArray(x)){
              if(typeof x[0]==='string'){
                const label=gwHtmlText(x[0]);
                if(label && label.length<300 && !options.includes(label) && !/^https:\/\//i.test(label)) options.push(label);
              }
              for(const y of x)collect(y,d+1);
            }else if(typeof x==='object'){
              for(const y of Object.values(x))collect(y,d+1);
            }
          };
          collect(node);
          out.push({id:String(id),title,description:desc,type,options:options.slice(0,200),images:images.slice(0,12)});
          seen.add(key);
        }
      }
      for(const child of node)walkGwFormData(child,out,seen,depth+1);
    }else if(typeof node==='object'){
      for(const value of Object.values(node))walkGwFormData(value,out,seen,depth+1);
    }
  }

  function parseGwGoogleForm(html,finalUrl){
    const titleMatch=html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const formTitle=titleMatch?gwHtmlText(titleMatch[1]).replace(/\s*-\s*Google Forms\s*$/i,''):'GW Want Number Form';
    let publicData=null;
    const marker='FB_PUBLIC_LOAD_DATA_';
    const start=html.indexOf(marker);
    if(start>=0){
      const eq=html.indexOf('=',start);
      if(eq>=0){
        let pos=eq+1,level=0,inString=false,escape=false,end=-1,started=false;
        for(;pos<html.length;pos++){
          const ch=html[pos];
          if(inString){
            if(escape){escape=false;continue}
            if(ch==='\\\\'){escape=true;continue}
            if(ch==='"')inString=false;
            continue;
          }
          if(ch==='"'){inString=true;continue}
          if(ch==='['||ch==='{'){level++;started=true}
          else if(ch===']'||ch==='}'){level--;if(started&&level===0){end=pos+1;break}}
        }
        if(end>eq){
          const raw=html.slice(eq+1,end).trim();
          try{publicData=JSON.parse(raw)}catch{}
        }
      }
    }

    const questions=[];
    if(publicData)walkGwFormData(publicData,questions,new Set());

    const imageUrls=[...new Set(
      [...html.matchAll(/https:\/\/[^"'<>\\\s)]+(?:png|jpe?g|webp)(?:\?[^"'<>\\\s)]*)?/gi)]
        .map(m=>m[0].replace(/&amp;/g,'&'))
        .filter(u=>!/googleusercontent\.com\/.*(?:logo|icon)|gstatic\.com/i.test(u))
    )].slice(0,250);

    const itemCandidates=[];
    for(const q of questions){
      const title=q.title||'';
      const description=q.description||'';
      const cls=parseGwListing(title,description);
      // Keep questions with product-like options/titles; exclude common account/contact fields.
      const accountField=/^(name|email|email address|cuid|account|store|phone|comments?|notes?)\b/i.test(title);
      if(accountField)continue;
      if(q.options.length){
        for(const option of q.options){
          const opt=gwHtmlText(option);
          if(!opt||/^(yes|no|other|none|n\/a)$/i.test(opt))continue;
          const c=parseGwListing(opt,description);
          itemCandidates.push({
            source_question_id:q.id,
            name:c.item_description,
            source_name:opt,
            description,
            source_image_url:Array.isArray(q.images)&&q.images.length?q.images[0]:null,
            ...c
          });
        }
      }else if(/\$|sku|product|warhammer|codex|battle|paint|brush|set|pack|box|kit/i.test(title+' '+description)){
        itemCandidates.push({
          source_question_id:q.id,
          name:cls.item_description,
          source_name:title,
          description,
          source_image_url:Array.isArray(q.images)&&q.images.length?q.images[0]:null,
          ...cls
        });
      }
    }

    const dedup=[];
    const names=new Set();
    for(const item of itemCandidates){
      const k=item.name.toLowerCase().replace(/\s+/g,' ').trim();
      if(!k||names.has(k))continue;
      names.add(k);dedup.push(item);
    }

    return {
      title:formTitle,
      final_url:finalUrl,
      questions,
      images:imageUrls,
      items:dedup,
      counts:{
        questions:questions.length,
        images:imageUrls.length,
        items:dedup.length,
        ready:dedup.filter(x=>x.post_enabled).length,
        review:dedup.filter(x=>x.case_pack_size && !x.post_enabled).length,
        filtered:dedup.filter(x=>!x.post_enabled).length
      }
    };
  }

  async function fetchGwFormPreview(sourceUrl){
    let input;
    try{input=new URL(String(sourceUrl||'').trim())}
    catch{throw Object.assign(new Error('Enter a valid GW Want Number Form URL.'),{status:400})}
    const allowedHost=/^(?:info\.games-workshop\.com|docs\.google\.com)$/i.test(input.hostname);
    if(input.protocol!=='https:'||!allowedHost){
      throw Object.assign(new Error('GW scrape accepts only Games Workshop tracking links or Google Forms URLs.'),{status:400});
    }
    const response=await fetch(input.toString(),{
      redirect:'follow',
      headers:{
        'User-Agent':'Mozilla/5.0 HobbyCorner-GW-Preorder-Scraper/1.0',
        'Accept':'text/html,application/xhtml+xml'
      }
    });
    if(!response.ok)throw Object.assign(new Error('GW form fetch failed: '+response.status+' '+response.statusText),{status:502});
    const html=await response.text();
    if(html.length>8*1024*1024)throw Object.assign(new Error('GW form response was unexpectedly large.'),{status:502});
    const parsed=parseGwGoogleForm(html,response.url||input.toString());
    return {...parsed,source_url:input.toString(),http_status:response.status,html_bytes:Buffer.byteLength(html)};
  }


  let graphTokenCache={token:null,expiresAt:0};

  async function getGraphAppToken(){
    const tenant=String(process.env.MS_GRAPH_TENANT_ID||'').trim();
    const clientId=String(process.env.MS_GRAPH_CLIENT_ID||'').trim();
    const clientSecret=String(process.env.MS_GRAPH_CLIENT_SECRET||'').trim();
    if(!tenant||!clientId||!clientSecret){
      throw Object.assign(new Error('Microsoft Graph app credentials are not configured.'),{status:503});
    }
    if(graphTokenCache.token && Date.now()<graphTokenCache.expiresAt-60000) return graphTokenCache.token;
    const body=new URLSearchParams({
      client_id:clientId,
      client_secret:clientSecret,
      scope:'https://graph.microsoft.com/.default',
      grant_type:'client_credentials'
    });
    const response=await fetch('https://login.microsoftonline.com/'+encodeURIComponent(tenant)+'/oauth2/v2.0/token',{
      method:'POST',
      headers:{'Content-Type':'application/x-www-form-urlencoded','Accept':'application/json'},
      body
    });
    const text=await response.text();
    let data={};try{data=text?JSON.parse(text):{}}catch{}
    if(!response.ok||!data.access_token){
      throw Object.assign(new Error('Microsoft Graph authentication failed: '+(data.error_description||data.error||response.statusText)),{status:502});
    }
    graphTokenCache={
      token:data.access_token,
      expiresAt:Date.now()+Math.max(300,Number(data.expires_in||3600))*1000
    };
    return data.access_token;
  }


  function decodeJwtPayload(token){
    try{
      const part=String(token||'').split('.')[1];
      if(!part)return {};
      const normalized=part.replace(/-/g,'+').replace(/_/g,'/');
      const padded=normalized+'='.repeat((4-normalized.length%4)%4);
      return JSON.parse(Buffer.from(padded,'base64').toString('utf8'));
    }catch{return {}}
  }

  async function graphGet(pathname){
    const token=await getGraphAppToken();
    const response=await fetch('https://graph.microsoft.com/v1.0'+pathname,{
      headers:{'Authorization':'Bearer '+token,'Accept':'application/json'}
    });
    const text=await response.text();
    let data={};try{data=text?JSON.parse(text):{}}catch{}
    if(!response.ok){
      const msg=data?.error?.message||data?.error_description||response.statusText;
      throw Object.assign(new Error('Microsoft Graph request failed: '+msg),{status:response.status===403?403:502});
    }
    return data;
  }

  async function listGraphMailFolders(mailbox){
    const encoded=encodeURIComponent(mailbox);
    const folders=[];
    let url='/users/'+encoded+'/mailFolders?$top=100&$select=id,displayName,parentFolderId,childFolderCount,totalItemCount';
    while(url){
      const data=await graphGet(url);
      for(const row of data.value||[])folders.push(row);
      const next=data['@odata.nextLink'];
      url=next?next.replace(/^https:\/\/graph\.microsoft\.com\/v1\.0/i,''):null;
    }
    return folders;
  }

  async function findGraphFolderByPath(mailbox,pathText){
    const parts=String(pathText||'Inbox/Games/Games Workshop').split('/').map(x=>x.trim()).filter(Boolean);
    if(!parts.length)throw Object.assign(new Error('GW mail folder path is empty.'),{status:400});
    let parentId=null;
    for(let i=0;i<parts.length;i++){
      const name=parts[i];
      let data;
      if(i===0 && /^inbox$/i.test(name)){
        data=await graphGet('/users/'+encodeURIComponent(mailbox)+'/mailFolders/inbox?$select=id,displayName,parentFolderId,childFolderCount,totalItemCount');
        parentId=data.id;
        continue;
      }
      const base=parentId
        ? '/users/'+encodeURIComponent(mailbox)+'/mailFolders/'+encodeURIComponent(parentId)+'/childFolders'
        : '/users/'+encodeURIComponent(mailbox)+'/mailFolders';
      const children=await graphGet(base+'?$top=100&$select=id,displayName,parentFolderId,childFolderCount,totalItemCount');
      const match=(children.value||[]).find(x=>String(x.displayName||'').localeCompare(name,undefined,{sensitivity:'accent'})===0);
      if(!match)throw Object.assign(new Error('Mailbox folder not found: '+parts.slice(0,i+1).join('/')),{status:404});
      parentId=match.id;
    }
    return parentId;
  }

  function extractGwEmailMetadata(message){
    const body=String(message?.body?.content||'');
    const text=gwHtmlText(body);
    const formMatch=body.match(/\[Want\s*Number\s*Form\]\(([\s\S]*?)\)/i) ||
      body.match(/href=["']([^"']+)["'][^>]*>\s*Want\s*Number\s*Form\s*</i);
    const formUrl=formMatch?String(formMatch[1]||'').replace(/\s+/g,'').replace(/&amp;/g,'&'):null;
    const due=(text.match(/Want Number Form will be due\s+(.+?)(?:\.|We will only accept)/i)||[])[1] ||
      (text.match(/Submissions for this form will be due on\s+(.+?)(?:\.|To ensure)/i)||[])[1] || null;
    const preorder=(text.match(/PRE-ORDER DATE\s+([0-9/]+)/i)||[])[1]||null;
    const release=(text.match(/RELEASE DATE\s+([0-9/]+)/i)||[])[1]||null;
    return {form_url:formUrl,due_text:due,preorder_date:preorder,release_date:release};
  }


  async function getLatestGwFormEmail(){
    const mailboxUserId=String(process.env.GW_MAILBOX_USER_ID||'').trim();
    const mailboxAddress=String(process.env.GW_MAILBOX_ADDRESS||'').trim();
    const mailbox=mailboxUserId||mailboxAddress;
    if(!mailbox)throw Object.assign(new Error('Set GW_MAILBOX_USER_ID (preferred) or GW_MAILBOX_ADDRESS.'),{status:400});
    const folderPath=String(process.env.GW_MAIL_FOLDER||'Inbox/Games/Games Workshop').trim();
    const folderId=await findGraphFolderByPath(mailbox,folderPath);
    const data=await graphGet(
      '/users/'+encodeURIComponent(mailbox)+'/mailFolders/'+encodeURIComponent(folderId)+
      '/messages?$top=25&$orderby=receivedDateTime%20desc&$select=id,subject,receivedDateTime,from,bodyPreview,body,webLink'
    );
    const candidates=(data.value||[])
      .filter(m=>String(m.from?.emailAddress?.address||'').toLowerCase()==='info@info.games-workshop.com')
      .map(m=>({...m,metadata:extractGwEmailMetadata(m)}))
      .filter(m=>m.metadata.form_url && m.metadata.release_date);
    if(!candidates.length){
      throw Object.assign(new Error('No recent Games Workshop Want Number Form email was found.'),{status:404});
    }
    return {
      mailbox_reference:mailboxUserId?'user_id':'address',
      folder_path:folderPath,
      message:candidates[0]
    };
  }


  function parseUsDateToIsoDate(value){
    const m=String(value||'').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if(!m)return null;
    return m[3]+'-'+String(m[1]).padStart(2,'0')+'-'+String(m[2]).padStart(2,'0');
  }

  function centralOffsetMinutes(year,month,day){
    const probe=new Date(Date.UTC(year,month-1,day,12,0,0));
    const parts=new Intl.DateTimeFormat('en-US',{
      timeZone:'America/Chicago',
      timeZoneName:'shortOffset',
      year:'numeric',month:'2-digit',day:'2-digit'
    }).formatToParts(probe);
    const tz=parts.find(p=>p.type==='timeZoneName')?.value||'GMT-6';
    const m=tz.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/i);
    if(!m)return -360;
    const mins=Number(m[2])*60+Number(m[3]||0);
    return (m[1]==='-'?-1:1)*mins;
  }

  function parseGwCutoffToIso(dueText,releaseDate,receivedAt){
    const text=String(dueText||'').replace(/\*+/g,' ').replace(/\s+/g,' ').trim();
    if(!text)return null;
    const months={january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,september:9,october:10,november:11,december:12};
    const m=text.match(/(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)?[,]?\s*([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:[,]?\s*(\d{4}))?[,]?\s*(?:at\s*)?(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    if(!m)return null;
    const month=months[String(m[1]).toLowerCase()];
    if(!month)return null;
    const releaseYear=String(releaseDate||'').match(/\/(\d{4})$/)?.[1];
    const receivedYear=receivedAt?new Date(receivedAt).getUTCFullYear():null;
    const year=Number(m[3]||releaseYear||receivedYear);
    if(!year)return null;
    let hour=Number(m[4]);
    const minute=Number(m[5]);
    const ampm=String(m[6]).toUpperCase();
    if(ampm==='PM'&&hour<12)hour+=12;
    if(ampm==='AM'&&hour===12)hour=0;
    const day=Number(m[2]);
    const offset=centralOffsetMinutes(year,month,day);
    const utc=Date.UTC(year,month-1,day,hour,minute,0)-offset*60000;
    return new Date(utc).toISOString();
  }

  function gwCustomerCutoffFromSupplierDeadline(supplierDeadlineIso){
    const t=Date.parse(String(supplierDeadlineIso||''));
    return Number.isNaN(t)?null:new Date(t-30*60*1000).toISOString();
  }

  async function alertGwAutoSubmitFailure(campaign,error){
    const channelId=String(gwAutoSubmitAlertChannelId||'').trim();
    const roleId=String(gwAutoSubmitAlertRoleId||'').trim();
    if(!channelId||!roleId)return {sent:false,reason:'alert_not_configured'};

    const claimed=await pool.query(
      `UPDATE preorder_campaigns
       SET auto_submit_last_error=$2,
           auto_submit_failure_alerted_at=COALESCE(auto_submit_failure_alerted_at,now()),
           updated_at=now()
       WHERE id=$1 AND auto_submit_failure_alerted_at IS NULL
       RETURNING id,name,order_due_at,gw_supplier_deadline_at`,
      [campaign.id,String(error?.message||error||'Unknown auto-submit error').slice(0,1800)]
    );
    if(!claimed.rows[0])return {sent:false,reason:'already_alerted'};

    const row=claimed.rows[0];
    const content='<@&'+roleId+'> **GW preorder auto-submit FAILED**\n'+
      '**Campaign:** '+row.name+'\n'+
      '**Customer cutoff:** '+new Date(row.order_due_at).toLocaleString('en-US',{timeZone:'America/Chicago'})+' CT\n'+
      '**GW deadline:** '+(row.gw_supplier_deadline_at?new Date(row.gw_supplier_deadline_at).toLocaleString('en-US',{timeZone:'America/Chicago'})+' CT':'unknown')+'\n'+
      '**Error:** '+String(error?.message||error||'Unknown error').slice(0,1500);

    try{
      await gwDiscordApi('/channels/'+encodeURIComponent(channelId)+'/messages',{
        method:'POST',
        body:JSON.stringify({content,allowed_mentions:{roles:[roleId]}})
      });
      return {sent:true};
    }catch(sendError){
      await pool.query(
        'UPDATE preorder_campaigns SET auto_submit_failure_alerted_at=NULL,updated_at=now() WHERE id=$1',
        [campaign.id]
      );
      throw sendError;
    }
  }

  function gwExternalEntryKey(item,index){
    const base=String(item.source_question_id||'q')+':'+
      String(item.name||'').toLowerCase().replace(/\s+/g,' ').trim();
    return base.slice(0,900)||('item:'+index);
  }

  router.post('/preorders/gw/sync-draft', requireDb, async (req,res)=>{
    const client=await pool.connect();
    try{
      const latest=await getLatestGwFormEmail();
      const m=latest.message;
      const scrape=await fetchGwFormPreview(m.metadata.form_url);
      const releaseDate=parseUsDateToIsoDate(m.metadata.release_date);
      const preorderDate=parseUsDateToIsoDate(m.metadata.preorder_date);
      const supplierDeadlineAt=parseGwCutoffToIso(m.metadata.due_text,m.metadata.release_date,m.receivedDateTime);
      const cutoffAt=gwCustomerCutoffFromSupplierDeadline(supplierDeadlineAt);
      const requestedLead=Number(req.body?.auto_submit_minutes_before||15);
      const autoMinutes=[10,15,20,30,60].includes(requestedLead)?requestedLead:15;
      const autoEnabled=req.body?.auto_submit_enabled!==false;
      const autoSubmitAt=supplierDeadlineAt
        ? new Date(Date.parse(supplierDeadlineAt)-autoMinutes*60*1000).toISOString()
        : null;
      if(!releaseDate)throw Object.assign(new Error('GW release date could not be parsed safely.'),{status:422});
      if(!supplierDeadlineAt||!cutoffAt||!autoSubmitAt){
        throw Object.assign(new Error('GW cutoff could not be parsed safely; review the email before creating the draft.'),{status:422});
      }

      await client.query('BEGIN');
      const existing=await client.query(
        "SELECT * FROM preorder_campaigns WHERE campaign_type='GW_WEEKLY' AND source_email_message_id=$1 FOR UPDATE",
        [m.id]
      );
      let campaign=existing.rows[0]||null;
      const canonicalFormUrl=scrape.final_url||m.metadata.form_url;
      if(!campaign){
        const created=await client.query(
          "INSERT INTO preorder_campaigns "+
          "(name,game,campaign_type,order_due_at,release_date,status,allocation_method,"+
          "source_form_url,source_email_message_id,external_submission_status,"+
          "auto_submit_enabled,auto_submit_minutes_before,gw_supplier_deadline_at,gw_auto_submit_at,notes) "+
          "VALUES ($1,'Games Workshop','GW_WEEKLY',$2,$3,'OPEN','QUEUE',$4,$5,'NOT_SUBMITTED',$6,$7,$8,$9,$10) "+
          "RETURNING *",
          [
            'GW Release '+m.metadata.release_date,
            cutoffAt,
            releaseDate,
            canonicalFormUrl,
            m.id,
            autoEnabled,
            autoMinutes,
            supplierDeadlineAt,
            autoSubmitAt,
            'Imported from Outlook: '+String(m.subject||'GW Trade News')
          ]
        );
        campaign=created.rows[0];
      }else{
        const updated=await client.query(
          "UPDATE preorder_campaigns SET "+
          "order_due_at=$2,release_date=$3,source_form_url=$4,"+
          "gw_supplier_deadline_at=$5,gw_auto_submit_at=$6,"+
          "auto_submit_enabled=$7,auto_submit_minutes_before=$8,notes=$9,updated_at=now() "+
          "WHERE id=$1 RETURNING *",
          [
            campaign.id,
            cutoffAt,
            releaseDate,
            canonicalFormUrl,
            supplierDeadlineAt,
            autoSubmitAt,
            autoEnabled,
            autoMinutes,
            'Imported from Outlook: '+String(m.subject||'GW Trade News')
          ]
        );
        campaign=updated.rows[0];
      }

      let inserted=0,updated=0;
      for(let i=0;i<(scrape.items||[]).length;i++){
        const item=scrape.items[i];
        const key=gwExternalEntryKey(item,i);
        const result=await client.query(
          "INSERT INTO preorder_products "+
          "(preorder_campaign_id,item_description,gw_source_item_description,sku,msrp,cost,release_date,external_entry_id,"+
          "gw_post_enabled,gw_post_disposition,gw_case_pack_size,gw_single_item_name,gw_single_msrp,gw_review_note,source_image_url) "+
          "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) "+
          "ON CONFLICT (preorder_campaign_id,external_entry_id) WHERE external_entry_id IS NOT NULL "+
          "DO UPDATE SET "+
          "item_description=EXCLUDED.item_description,gw_source_item_description=EXCLUDED.gw_source_item_description,"+
          "sku=COALESCE(EXCLUDED.sku,preorder_products.sku),msrp=COALESCE(EXCLUDED.msrp,preorder_products.msrp),"+
          "cost=COALESCE(EXCLUDED.cost,preorder_products.cost),release_date=EXCLUDED.release_date,"+
          "source_image_url=COALESCE(preorder_products.image_url,EXCLUDED.source_image_url),"+
          "gw_post_enabled=CASE WHEN preorder_products.gw_reviewed_at IS NULL THEN EXCLUDED.gw_post_enabled ELSE preorder_products.gw_post_enabled END,"+
          "gw_post_disposition=CASE WHEN preorder_products.gw_reviewed_at IS NULL THEN EXCLUDED.gw_post_disposition ELSE preorder_products.gw_post_disposition END,"+
          "gw_case_pack_size=CASE WHEN preorder_products.gw_reviewed_at IS NULL THEN EXCLUDED.gw_case_pack_size ELSE preorder_products.gw_case_pack_size END,"+
          "gw_single_item_name=COALESCE(preorder_products.gw_single_item_name,EXCLUDED.gw_single_item_name),"+
          "gw_single_msrp=COALESCE(preorder_products.gw_single_msrp,EXCLUDED.gw_single_msrp),"+
          "gw_review_note=CASE WHEN preorder_products.gw_reviewed_at IS NULL THEN EXCLUDED.gw_review_note ELSE preorder_products.gw_review_note END "+
          "RETURNING (xmax = 0) AS inserted",
          [
            campaign.id,item.item_description||item.name,item.source_item_description||item.source_name||item.name,
            item.short_code||null,item.msrp??null,item.cost??null,releaseDate,key,Boolean(item.post_enabled),
            item.disposition||'REVIEW',item.case_pack_size||null,item.suggested_single_name||null,
            item.suggested_single_msrp??null,(item.reasons||[]).join('; ')||null,item.source_image_url||null
          ]
        );
        if(result.rows[0]?.inserted)inserted++;else updated++;
      }

      await client.query('COMMIT');
      res.status(existing.rows[0]?200:201).json({
        ok:true,
        created:!existing.rows[0],
        campaign,
        preorder_date:preorderDate,
        email:{
          id:m.id,
          subject:m.subject,
          received_at:m.receivedDateTime,
          due_text:m.metadata.due_text,
          release_date:m.metadata.release_date,
          form_url:canonicalFormUrl,
          supplier_deadline_at:supplierDeadlineAt,
          cutoff_at:cutoffAt,
          auto_submit_at:autoSubmitAt
        },
        scrape_counts:scrape.counts,
        products:{inserted,updated,total:(scrape.items||[]).length}
      });
    }catch(error){
      try{await client.query('ROLLBACK')}catch{}
      console.error('[special-orders] GW draft sync failed:',error);
      res.status(error.status||500).json({error:error.message});
    }finally{
      client.release();
    }
  });

  router.get('/preorders/gw/sync-preview', requireDb, async (req,res)=>{
    try{
      const latest=await getLatestGwFormEmail();
      const m=latest.message;
      const scrape=await fetchGwFormPreview(m.metadata.form_url);
      res.set('Cache-Control','no-store');
      res.json({
        ok:true,
        mailbox_reference:latest.mailbox_reference,
        folder_path:latest.folder_path,
        email:{
          id:m.id,
          subject:m.subject,
          received_at:m.receivedDateTime,
          web_link:m.webLink||null,
          ...m.metadata,
          form_url:scrape.final_url||m.metadata.form_url,
          release_date_iso:parseUsDateToIsoDate(m.metadata.release_date),
          supplier_deadline_at:parseGwCutoffToIso(m.metadata.due_text,m.metadata.release_date,m.receivedDateTime),
          cutoff_at:gwCustomerCutoffFromSupplierDeadline(parseGwCutoffToIso(m.metadata.due_text,m.metadata.release_date,m.receivedDateTime)),
          auto_submit_at:(()=>{
            const deadline=parseGwCutoffToIso(m.metadata.due_text,m.metadata.release_date,m.receivedDateTime);
            return deadline?new Date(Date.parse(deadline)-15*60*1000).toISOString():null;
          })()
        },
        scrape
      });
    }catch(error){
      console.error('[special-orders] GW email sync preview failed:',error);
      res.status(error.status||500).json({error:error.message});
    }
  });

  router.get('/preorders/gw/graph-test', requireDb, async (req,res)=>{
    try{
      const mailboxUserId=String(process.env.GW_MAILBOX_USER_ID||'').trim();
      const mailboxAddress=String(process.env.GW_MAILBOX_ADDRESS||req.query.mailbox||'').trim();
      const mailbox=mailboxUserId||mailboxAddress;
      if(!mailbox)return res.status(400).json({error:'Set GW_MAILBOX_USER_ID (preferred) or GW_MAILBOX_ADDRESS.'});
      const folderPath=String(process.env.GW_MAIL_FOLDER||'Inbox/Games/Games Workshop').trim();
      const token=await getGraphAppToken();
      const tokenPayload=decodeJwtPayload(token);
      const tokenRoles=Array.isArray(tokenPayload.roles)?tokenPayload.roles:[];
      let folderId;
      try{
        folderId=await findGraphFolderByPath(mailbox,folderPath);
      }catch(error){
        return res.status(error.status||500).json({
          error:error.message,
          stage:'resolve_mail_folder',
          token_roles:tokenRoles,
          has_mail_read:tokenRoles.includes('Mail.Read'),
          mailbox_reference:mailboxUserId?'user_id':'address',
          folder_path:folderPath
        });
      }
      let data;
      try{
        data=await graphGet(
          '/users/'+encodeURIComponent(mailbox)+'/mailFolders/'+encodeURIComponent(folderId)+
          '/messages?$top=12&$orderby=receivedDateTime%20desc&$select=id,subject,receivedDateTime,from,bodyPreview,body,webLink'
        );
      }catch(error){
        return res.status(error.status||500).json({
          error:error.message,
          stage:'list_messages',
          token_roles:tokenRoles,
          has_mail_read:tokenRoles.includes('Mail.Read'),
          mailbox_reference:mailboxUserId?'user_id':'address',
          folder_path:folderPath
        });
      }
      const messages=(data.value||[])
        .filter(m=>String(m.from?.emailAddress?.address||'').toLowerCase()==='info@info.games-workshop.com')
        .map(m=>({
          id:m.id,
          subject:m.subject,
          received_at:m.receivedDateTime,
          sender:m.from?.emailAddress?.address||null,
          web_link:m.webLink||null,
          ...extractGwEmailMetadata(m)
        }));
      res.set('Cache-Control','no-store');
      res.json({
        ok:true,
        token_roles:tokenRoles,
        has_mail_read:tokenRoles.includes('Mail.Read'),
        mailbox_reference:mailboxUserId?'user_id':'address',
        mailbox:mailboxUserId?'configured Entra user object ID':mailboxAddress,
        credential_expiration:(()=>{
          const raw=String(process.env.MS_GRAPH_CLIENT_SECRET_EXPIRES_AT||'').trim();
          if(!raw)return {configured:false};
          let t=Date.parse(raw);
          if(Number.isNaN(t)){
            const m=raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
            if(m)t=Date.UTC(Number(m[3]),Number(m[1])-1,Number(m[2]),23,59,59);
          }
          if(Number.isNaN(t))return {configured:true,valid:false,value:raw};
          const days=Math.ceil((t-Date.now())/86400000);
          return {
            configured:true,
            valid:true,
            expires_at:new Date(t).toISOString(),
            days_remaining:days,
            warning:days<=60,
            critical:days<=14
          };
        })(),
        folder_path:folderPath,
        folder_id:folderId,
        matching_messages:messages.length,
        messages
      });
    }catch(error){
      console.error('[special-orders] GW Graph test failed:',error);
      res.status(error.status||500).json({error:error.message});
    }
  });

  router.post('/preorders/gw/scrape-preview', requireDb, async (req,res)=>{
    try{
      const preview=await fetchGwFormPreview(req.body?.source_url);
      res.set('Cache-Control','no-store');
      res.json(preview);
    }catch(error){
      console.error('[special-orders] GW scrape preview failed:',error);
      res.status(error.status||500).json({error:error.message});
    }
  });

  router.post('/preorders/gw/campaigns', requireDb, async (req,res)=>{
    const body=req.body||{};
    const name=String(body.name||'').trim();
    const formUrl=String(body.source_form_url||'').trim();
    const dueAt=body.order_due_at||null;
    if(!name||!formUrl||!dueAt){
      return res.status(400).json({error:'name, source_form_url, and order_due_at are required.'});
    }

    let formPreview;
    try{
      formPreview=await fetchGwFormPreview(formUrl);
    }catch(error){
      return res.status(error.status||400).json({error:error.message});
    }
    const canonicalFormUrl=String(formPreview.final_url||formUrl).trim();

    const due=new Date(dueAt);
    if(Number.isNaN(due.getTime()))return res.status(400).json({error:'order_due_at is invalid.'});

    let supplierDeadline=body.gw_supplier_deadline_at?new Date(body.gw_supplier_deadline_at):new Date(due.getTime()+30*60*1000);
    if(Number.isNaN(supplierDeadline.getTime()))return res.status(400).json({error:'gw_supplier_deadline_at is invalid.'});
    const requestedLead=Number(body.auto_submit_minutes_before||15);
    const autoMinutes=[10,15,20,30,60].includes(requestedLead)?requestedLead:15;
    const autoSubmitAt=new Date(supplierDeadline.getTime()-autoMinutes*60*1000);

    const autoEnabled=body.auto_submit_enabled!==false;
    const {rows}=await pool.query(
      "INSERT INTO preorder_campaigns "+
      "(name,game,campaign_type,order_due_at,release_date,status,allocation_method,"+
      "source_form_url,external_submission_status,auto_submit_enabled,auto_submit_minutes_before,"+
      "gw_supplier_deadline_at,gw_auto_submit_at,notes) "+
      "VALUES ($1,'Games Workshop','GW_WEEKLY',$2,$3,'OPEN','QUEUE',$4,'NOT_SUBMITTED',$5,$6,$7,$8,$9) "+
      "RETURNING *",
      [
        name,
        due.toISOString(),
        body.release_date||null,
        canonicalFormUrl,
        autoEnabled,
        autoMinutes,
        supplierDeadline.toISOString(),
        autoSubmitAt.toISOString(),
        body.notes||null
      ]
    );
    res.status(201).json(rows[0]);
  });


  function gwDiscordPostFromProduct(product,campaign){
    if(product.gw_post_enabled===false)return {publish:false,reason:'Post disabled',product_id:product.id};
    const packSize=Number(product.gw_case_pack_size||0);
    const isPack=packSize>1;
    const title=String(isPack?(product.gw_single_item_name||''):product.item_description||'').trim();
    const msrp=isPack?(product.gw_single_msrp==null?null:Number(product.gw_single_msrp)):(product.msrp==null?null:Number(product.msrp));
    if(!title)return {publish:false,reason:'Missing customer-facing item description',product_id:product.id};
    if(isPack&&(msrp==null||!Number.isFinite(msrp)||msrp<0))return {publish:false,reason:'Case pack needs confirmed single-item MSRP before posting',product_id:product.id};
    const release=product.release_date||campaign.release_date||null;
    const sku=String(product.sku||'NO_CODE').trim()||'NO_CODE';
    const detailLines=[];
    if(msrp!=null&&Number.isFinite(msrp))detailLines.push('MSRP: $'+msrp.toFixed(2));
    if(release)detailLines.push('Release: '+String(release).slice(0,10));
    detailLines.push('React to preorder 1.');
    return {publish:true,product_id:product.id,campaign_id:campaign.id,title,description:detailLines.join('\\n'),sku,msrp,release_date:release,image_url:product.image_url||product.source_image_url||null,mode:isPack?'SPLIT_TO_SINGLES':'AS_IS',case_pack_size:isPack?packSize:null,footer:'Code: '+sku+' · GW preorder'};
  }
  async function gwDiscordApi(pathname,options={}){
    if(!discordToken)throw Object.assign(new Error('Discord bot token is not configured for Special Orders.'),{status:503});
    const response=await fetch('https://discord.com/api/v10'+pathname,{
      ...options,
      headers:{Authorization:'Bot '+discordToken,'Content-Type':'application/json',...(options.headers||{})}
    });
    const text=await response.text();
    let body={};try{body=text?JSON.parse(text):{}}catch{}
    if(!response.ok){
      const message=body.message||body.error||response.statusText||'Discord API request failed.';
      throw Object.assign(new Error('Discord API: '+message),{status:502,discordStatus:response.status});
    }
    return body;
  }

  async function gwDiscordDm(discordUserId,content){
    const dm=await gwDiscordApi('/users/@me/channels',{method:'POST',body:JSON.stringify({recipient_id:String(discordUserId)})});
    return gwDiscordApi('/channels/'+encodeURIComponent(String(dm.id))+'/messages',{method:'POST',body:JSON.stringify({content:String(content).slice(0,1900),allowed_mentions:{parse:[]}})});
  }

  async function buildGwCustomerOrderSummary(campaignId,customerId){
    const {rows}=await pool.query(
      "SELECT pp.item_description,pp.gw_single_item_name,pp.gw_case_pack_size,pp.sku,pr.requested_quantity "+
      "FROM preorder_requests pr JOIN preorder_products pp ON pp.id=pr.preorder_product_id "+
      "WHERE pp.preorder_campaign_id=$1 AND pr.customer_id=$2 AND pr.status='REQUESTED' "+
      "ORDER BY COALESCE(pp.gw_single_item_name,pp.item_description)",
      [campaignId,customerId]
    );
    return rows;
  }

  async function processGwCustomerNotifications(){
    if(!pool||!discordToken)return;
    let rows=[];
    try{
      const result=await pool.query(
        "SELECT n.*,c.discord_user_id,pc.name AS campaign_name FROM notifications n "+
        "JOIN customers c ON c.id=n.customer_id JOIN preorder_campaigns pc ON pc.id=n.preorder_campaign_id "+
        "WHERE n.status='PENDING' AND n.channel IN ('DISCORD_GW_ORDER_CONFIRMATION','DISCORD_GW_ORDER_UPDATE') "+
        "AND (n.not_before IS NULL OR n.not_before<=now()) ORDER BY n.created_at LIMIT 20"
      );
      rows=result.rows;
    }catch(error){console.error('[special-orders] GW confirmation queue read failed:',error);return}
    for(const n of rows){
      try{
        const claim=await pool.query("UPDATE notifications SET status='QUEUED' WHERE id=$1 AND status='PENDING' RETURNING *",[n.id]);
        if(!claim.rows[0])continue;
        const items=await buildGwCustomerOrderSummary(n.preorder_campaign_id,n.customer_id);
        const lines=items.length?items.map(x=>'- '+(x.gw_case_pack_size>1?(x.gw_single_item_name||x.item_description):x.item_description)+(x.sku?' ('+x.sku+')':'')+' x'+x.requested_quantity):['- No current GW preorder items'];
        let message;
        if(n.channel==='DISCORD_GW_ORDER_UPDATE'){
          const removed=n.metadata?.removed_item||'an item';
          message='GW preorder update for '+n.campaign_name+':\nRemoved: '+removed+'\n\nCurrent order:\n'+lines.join('\n');
        }else{
          message='GW preorder confirmation for '+n.campaign_name+':\n'+lines.join('\n')+'\n\nReply to the store if anything looks wrong.';
        }
        const sent=await gwDiscordDm(n.discord_user_id,message);
        await pool.query("UPDATE notifications SET status='SENT',external_message_id=$1,sent_at=now(),error=NULL WHERE id=$2",[String(sent.id),n.id]);
      }catch(error){
        console.error('[special-orders] GW customer notification failed:',error);
        await pool.query("UPDATE notifications SET status='FAILED',error=$1 WHERE id=$2",[String(error.message||error).slice(0,1800),n.id]).catch(()=>{});
      }
    }
  }

  if(!globalThis.__hcGwNotificationWorker){
    globalThis.__hcGwNotificationWorker=setInterval(()=>{processGwCustomerNotifications().catch(error=>console.error('[special-orders] GW notification worker error:',error))},60000);
    if(typeof globalThis.__hcGwNotificationWorker.unref==='function')globalThis.__hcGwNotificationWorker.unref();
  }

  router.post('/preorders/gw/discord-reaction', requireDb, async (req,res)=>{
    const body=req.body||{};
    const messageId=String(body.message_id||'').trim();
    const discordUserId=String(body.discord_user_id||'').trim();
    const discordUsername=String(body.discord_username||'').trim();
    const action=String(body.action||'').toUpperCase();
    if(!messageId||!discordUserId||!['ADD','REMOVE'].includes(action))return res.status(400).json({error:'message_id, discord_user_id, and ADD/REMOVE action are required.'});
    const mapped=await pool.query(
      "SELECT m.*,pp.item_description,pp.gw_single_item_name,pp.gw_case_pack_size FROM preorder_discord_messages m JOIN preorder_products pp ON pp.id=m.preorder_product_id WHERE m.message_id=$1",
      [messageId]
    );
    const m=mapped.rows[0];
    if(!m)return res.status(404).json({error:'Discord message is not mapped to a GW preorder item.'});
    const customerResult=await pool.query("SELECT id,name,discord_user_id FROM customers WHERE discord_user_id=$1 LIMIT 1",[discordUserId]);
    const customer=customerResult.rows[0]||null;
    await pool.query(
      "INSERT INTO preorder_discord_reactions (preorder_campaign_id,preorder_product_id,message_id,discord_user_id,discord_username,customer_id,action) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [m.preorder_campaign_id,m.preorder_product_id,messageId,discordUserId,discordUsername||null,customer?.id||null,action]
    );
    if(!customer)return res.status(202).json({ok:true,matched_customer:false});
    const sourceKey='discord-gw:'+messageId+':'+discordUserId;
    if(action==='ADD'){
      await pool.query(
        "INSERT INTO preorder_requests (preorder_product_id,customer_id,requested_quantity,status,notes,source_key) VALUES ($1,$2,1,'REQUESTED',$3,$4) "+
        "ON CONFLICT (source_key) DO UPDATE SET status='REQUESTED',requested_quantity=1,notes=EXCLUDED.notes",
        [m.preorder_product_id,customer.id,'Discord reaction by '+(discordUsername||discordUserId),sourceKey]
      );
      await pool.query(
        "INSERT INTO notifications (preorder_campaign_id,customer_id,channel,recipient,status,message,not_before) "+
        "VALUES ($1,$2,'DISCORD_GW_ORDER_CONFIRMATION',$3,'PENDING','GW preorder confirmation',now()+interval '10 minutes') "+
        "ON CONFLICT (preorder_campaign_id,customer_id,channel) WHERE preorder_campaign_id IS NOT NULL AND customer_id IS NOT NULL AND channel='DISCORD_GW_ORDER_CONFIRMATION' AND status IN ('PENDING','QUEUED') "+
        "DO UPDATE SET status='PENDING',not_before=now()+interval '10 minutes',error=NULL",
        [m.preorder_campaign_id,customer.id,discordUserId]
      );
    }else{
      const priorConfirmation=await pool.query(
        "SELECT id FROM notifications WHERE preorder_campaign_id=$1 AND customer_id=$2 AND channel='DISCORD_GW_ORDER_CONFIRMATION' AND status='SENT' LIMIT 1",
        [m.preorder_campaign_id,customer.id]
      );
      await pool.query("UPDATE preorder_requests SET status='CANCELLED',notes=COALESCE(notes,'')||' | Discord reaction removed' WHERE source_key=$1",[sourceKey]);
      if(priorConfirmation.rows[0]){
        const removed=(m.gw_case_pack_size>1?(m.gw_single_item_name||m.item_description):m.item_description);
        await pool.query(
          "INSERT INTO notifications (preorder_campaign_id,customer_id,channel,recipient,status,message,metadata,not_before) "+
          "VALUES ($1,$2,'DISCORD_GW_ORDER_UPDATE',$3,'PENDING','GW preorder update',$4::jsonb,now()) "+
          "ON CONFLICT (preorder_campaign_id,customer_id,channel) WHERE preorder_campaign_id IS NOT NULL AND customer_id IS NOT NULL AND channel='DISCORD_GW_ORDER_UPDATE' AND status IN ('PENDING','QUEUED') "+
          "DO UPDATE SET status='PENDING',metadata=EXCLUDED.metadata,not_before=now(),error=NULL",
          [m.preorder_campaign_id,customer.id,discordUserId,JSON.stringify({removed_item:removed})]
        );
      }else{
        await pool.query("UPDATE notifications SET status='SUPPRESSED',suppression_reason='No current items after pre-confirmation removal',suppressed_at=now() WHERE preorder_campaign_id=$1 AND customer_id=$2 AND channel='DISCORD_GW_ORDER_CONFIRMATION' AND status IN ('PENDING','QUEUED') AND NOT EXISTS (SELECT 1 FROM preorder_requests pr JOIN preorder_products pp ON pp.id=pr.preorder_product_id WHERE pp.preorder_campaign_id=$1 AND pr.customer_id=$2 AND pr.status='REQUESTED')",[m.preorder_campaign_id,customer.id]);
      }
    }
    res.json({ok:true,matched_customer:true,customer_id:customer.id,action});
  });
  router.get('/preorders/gw/campaigns/:id/discord-preview', requireDb, async (req,res)=>{
    try{
      const campaignResult=await pool.query(
        "SELECT * FROM preorder_campaigns WHERE id=$1 AND campaign_type='GW_WEEKLY'",
        [req.params.id]
      );
      const campaign=campaignResult.rows[0];
      if(!campaign)return res.status(404).json({error:'GW campaign not found.'});
      const productsResult=await pool.query(
        'SELECT * FROM preorder_products WHERE preorder_campaign_id=$1 ORDER BY item_description',
        [campaign.id]
      );
      const evaluated=productsResult.rows.map(p=>gwDiscordPostFromProduct(p,campaign));
      const posts=evaluated.filter(x=>x.publish);
      const blocked=evaluated.filter(x=>!x.publish && x.reason!=='Do not post');
      const suppressed=evaluated.filter(x=>!x.publish && x.reason==='Do not post');
      const channelId=String(gwPreorderChannelId||'').trim();
      const publicationResult=channelId
        ? await pool.query(
            'SELECT id,status,post_count,message_ids,published_by,error,started_at,published_at,updated_at FROM preorder_discord_publications WHERE preorder_campaign_id=$1 AND channel_id=$2',
            [campaign.id,channelId]
          )
        : {rows:[]};
      const publication=publicationResult.rows[0]||null;
      res.set('Cache-Control','no-store');
      res.json({
        campaign:{
          id:campaign.id,
          name:campaign.name,
          release_date:campaign.release_date,
          order_due_at:campaign.order_due_at,
          external_submission_status:campaign.external_submission_status
        },
        test_channel_id:channelId||null,
        ready_to_publish:Boolean(channelId && discordToken && blocked.length===0 && posts.length>0 && !publication),
        counts:{posts:posts.length,blocked:blocked.length,suppressed:suppressed.length},
        posts,
        blocked,
        suppressed,
        publication
      });
    }catch(error){
      console.error('[special-orders] GW Discord preview failed:',error);
      res.status(500).json({error:error.message});
    }
  });

  router.post('/preorders/gw/campaigns/:id/discord-publish', requireDb, async (req,res)=>{
    const channelId=String(gwPreorderChannelId||'').trim();
    if(!discordToken||!channelId){
      return res.status(503).json({error:'GW Discord publishing is not configured on the Special Orders service.'});
    }

    let publication=null;
    try{
      const campaignResult=await pool.query(
        "SELECT * FROM preorder_campaigns WHERE id=$1 AND campaign_type='GW_WEEKLY'",
        [req.params.id]
      );
      const campaign=campaignResult.rows[0];
      if(!campaign)return res.status(404).json({error:'GW campaign not found.'});

      const productsResult=await pool.query(
        'SELECT * FROM preorder_products WHERE preorder_campaign_id=$1 ORDER BY item_description',
        [campaign.id]
      );
      const evaluated=productsResult.rows.map(p=>gwDiscordPostFromProduct(p,campaign));
      const posts=evaluated.filter(x=>x.publish);
      const blocked=evaluated.filter(x=>!x.publish && x.reason!=='Do not post');
      if(blocked.length){
        return res.status(409).json({
          error:'GW Discord publishing is blocked until every non-suppressed product is reviewed.',
          blocked,
          counts:{posts:posts.length,blocked:blocked.length}
        });
      }
      if(!posts.length)return res.status(400).json({error:'There are no approved GW products to publish.'});

      const dbClient=await pool.connect();
      try{
        await dbClient.query('BEGIN');
        const existing=await dbClient.query(
          'SELECT * FROM preorder_discord_publications WHERE preorder_campaign_id=$1 AND channel_id=$2 FOR UPDATE',
          [campaign.id,channelId]
        );
        if(existing.rows[0]){
          await dbClient.query('ROLLBACK');
          return res.status(409).json({
            error:'This GW campaign already has a Discord publication record. Duplicate publication is blocked.',
            publication:existing.rows[0]
          });
        }
        const insertSql=
          "INSERT INTO preorder_discord_publications "+
          "(preorder_campaign_id,channel_id,status,post_count,message_ids,published_by) "+
          "VALUES ($1,$2,'PUBLISHING',$3,'[]'::jsonb,$4) RETURNING *";
        const inserted=await dbClient.query(
          insertSql,
          [campaign.id,channelId,posts.length,String(req.body?.published_by||'gw-web').trim()||'gw-web']
        );
        publication=inserted.rows[0];
        await dbClient.query('COMMIT');
      }catch(error){
        try{await dbClient.query('ROLLBACK')}catch{}
        throw error;
      }finally{
        dbClient.release();
      }

      const messageIds=[];
      for(const post of posts){
        const embed={
          title:String(post.title||'GW Preorder').slice(0,256),
          description:String(post.description||'').slice(0,4096),
          footer:{text:String(post.footer||'').slice(0,2048)}
        };
        if(post.image_url)embed.image={url:String(post.image_url)};
        const message=await gwDiscordApi('/channels/'+encodeURIComponent(channelId)+'/messages',{
          method:'POST',
          body:JSON.stringify({embeds:[embed],allowed_mentions:{parse:[]}})
        });
        messageIds.push(String(message.id));
        await pool.query(
          'UPDATE preorder_discord_publications SET message_ids=$1::jsonb,updated_at=now() WHERE id=$2',
          [JSON.stringify(messageIds),publication.id]
        );
        await pool.query(
          'INSERT INTO preorder_discord_messages (preorder_campaign_id,preorder_product_id,publication_id,channel_id,message_id) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (message_id) DO NOTHING',
          [campaign.id,post.product_id,publication.id,channelId,String(message.id)]
        );
        try{
          await gwDiscordApi(
            '/channels/'+encodeURIComponent(channelId)+'/messages/'+encodeURIComponent(String(message.id))+
            '/reactions/'+encodeURIComponent('✅')+'/@me',
            {method:'PUT'}
          );
        }catch(reactionError){
          console.warn('[special-orders] Could not add GW preorder reaction to Discord message '+message.id+':',reactionError.message);
        }
      }

      await pool.query(
        "UPDATE preorder_discord_publications SET status='PUBLISHED',published_at=now(),updated_at=now(),error=NULL WHERE id=$1",
        [publication.id]
      );
      await pool.query(
        'UPDATE preorder_campaigns SET discord_published_at=now(),updated_at=now() WHERE id=$1',
        [campaign.id]
      );
      res.json({ok:true,publication_id:publication.id,channel_id:channelId,published_count:messageIds.length,message_ids:messageIds});
    }catch(error){
      console.error('[special-orders] GW Discord publish failed:',error);
      if(publication?.id){
        try{
          const current=await pool.query('SELECT message_ids FROM preorder_discord_publications WHERE id=$1',[publication.id]);
          const ids=current.rows[0]?.message_ids||[];
          await pool.query(
            "UPDATE preorder_discord_publications SET status=$1,error=$2,updated_at=now() WHERE id=$3",
            [ids.length?'PARTIAL':'FAILED',String(error.message||error).slice(0,2000),publication.id]
          );
          return res.status(error.status||502).json({
            error:error.message,publication_id:publication.id,status:ids.length?'PARTIAL':'FAILED',
            published_count:ids.length,message_ids:ids
          });
        }catch(recordError){
          console.error('[special-orders] Could not record GW Discord publish failure:',recordError);
        }
      }
      res.status(error.status||500).json({error:error.message});
    }
  });

  router.patch('/preorders/gw/products/:id', requireDb, async (req,res)=>{
    const body=req.body||{};
    const postEnabled=body.gw_post_enabled==null?null:Boolean(body.gw_post_enabled);
    const itemDescription=body.item_description==null?null:String(body.item_description).trim();
    const sku=body.sku==null?null:String(body.sku).trim();
    const msrp=body.msrp==null?null:Math.max(0,Number(body.msrp)||0);
    const cost=body.cost==null?null:Math.max(0,Number(body.cost)||0);
    const packSize=body.gw_case_pack_size==null?null:Math.max(1,Math.floor(Number(body.gw_case_pack_size)||1));
    const singleName=body.gw_single_item_name==null?null:String(body.gw_single_item_name).trim();
    const singleMsrp=body.gw_single_msrp==null?null:Math.max(0,Number(body.gw_single_msrp)||0);
    const sql="UPDATE preorder_products pp SET "+
      "item_description=CASE WHEN $1::text IS NULL THEN item_description ELSE $1 END,"+
      "sku=CASE WHEN $2::text IS NULL THEN sku ELSE NULLIF($2,'') END,"+
      "msrp=CASE WHEN $3::numeric IS NULL THEN msrp ELSE $3 END,"+
      "cost=CASE WHEN $4::numeric IS NULL THEN cost ELSE $4 END,"+
      "gw_post_enabled=CASE WHEN $5::boolean IS NULL THEN gw_post_enabled ELSE $5 END,"+
      "gw_case_pack_size=CASE WHEN $6::int IS NULL THEN gw_case_pack_size ELSE $6 END,"+
      "gw_single_item_name=CASE WHEN $7::text IS NULL THEN gw_single_item_name ELSE NULLIF($7,'') END,"+
      "gw_single_msrp=CASE WHEN $8::numeric IS NULL THEN gw_single_msrp ELSE $8 END,"+
      "gw_post_disposition=CASE WHEN $5::boolean IS NULL THEN gw_post_disposition WHEN $5::boolean=false THEN 'DO_NOT_POST' "+
      "WHEN COALESCE($6,gw_case_pack_size,1)>1 THEN 'SPLIT_TO_SINGLES' ELSE 'POST_AS_IS' END,"+
      "gw_reviewed_at=now(),gw_reviewed_by=COALESCE(NULLIF(trim($9),''),'gw-web') "+
      "FROM preorder_campaigns pc WHERE pp.id=$10 AND pc.id=pp.preorder_campaign_id AND pc.campaign_type='GW_WEEKLY' RETURNING pp.*";
    const {rows}=await pool.query(sql,[itemDescription,sku,msrp,cost,postEnabled,packSize,singleName,singleMsrp,body.gw_reviewed_by??null,req.params.id]);
    if(!rows[0])return res.status(404).json({error:'GW preorder product not found.'});
    res.json(rows[0]);
  });
  router.post('/preorders/gw/campaigns/:id/auto-submit-failure', requireDb, async (req,res)=>{
    try{
      const {rows}=await pool.query("SELECT * FROM preorder_campaigns WHERE id=$1 AND campaign_type='GW_WEEKLY'",[req.params.id]);
      const campaign=rows[0];
      if(!campaign)return res.status(404).json({error:'GW preorder campaign not found.'});
      const result=await alertGwAutoSubmitFailure(campaign,new Error(String(req.body?.error||'GW auto-submit failed.')));
      res.json({ok:true,...result});
    }catch(error){
      console.error('[special-orders] GW auto-submit failure alert failed:',error);
      res.status(error.status||500).json({error:error.message});
    }
  });

  router.post('/preorders/gw/campaigns/:id/mark-submitted', requireDb, async (req,res)=>{
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      const campaignResult=await client.query(
        "SELECT * FROM preorder_campaigns WHERE id=$1 AND campaign_type='GW_WEEKLY' FOR UPDATE",
        [req.params.id]
      );
      const campaign=campaignResult.rows[0];
      if(!campaign){
        await client.query('ROLLBACK');
        return res.status(404).json({error:'GW preorder campaign not found.'});
      }
      if(campaign.external_submission_status==='SUBMITTED'){
        await client.query('ROLLBACK');
        return res.status(409).json({error:'This GW campaign is already recorded as submitted.'});
      }

      const products=await client.query(`
        SELECT pp.id,pp.item_description,pp.sku,pp.msrp,pp.store_order_quantity,
               COALESCE(sum(pr.requested_quantity),0)::int AS requested_total
        FROM preorder_products pp
        LEFT JOIN preorder_requests pr ON pr.preorder_product_id=pp.id
        WHERE pp.preorder_campaign_id=$1
        GROUP BY pp.id
        ORDER BY pp.item_description
      `,[campaign.id]);

      for(const p of products.rows){
        const submitted=Math.max(0,Number(p.requested_total||0)+Number(p.store_order_quantity||0));
        await client.query(`
          UPDATE preorder_products
          SET submitted_quantity=$1,ordered_quantity=$1,
              submitted_value=CASE WHEN msrp IS NULL THEN NULL ELSE $1*msrp END
          WHERE id=$2
        `,[submitted,p.id]);
      }

      await client.query(`
        UPDATE preorder_campaigns
        SET external_submission_status='SUBMITTED',submitted_at=now(),status='ORDERED',updated_at=now()
        WHERE id=$1
      `,[campaign.id]);

      const totalUnits=products.rows.reduce((n,p)=>n+Number(p.requested_total||0)+Number(p.store_order_quantity||0),0);
      const staffMessage='GW preorder submitted: '+campaign.name+
        ' | '+totalUnits+' total unit(s) | '+products.rows.length+' product(s).';
      await client.query(`
        INSERT INTO notifications (preorder_campaign_id,channel,status,message)
        VALUES ($1,'DISCORD_GW_STAFF_SUBMITTED','PENDING',$2)
      `,[campaign.id,staffMessage]);

      const customers=await client.query(`
        SELECT c.id AS customer_id,c.name,c.discord_user_id,
               json_agg(json_build_object(
                 'item',pp.item_description,'sku',pp.sku,'qty',pr.requested_quantity
               ) ORDER BY pp.item_description) AS items
        FROM preorder_requests pr
        JOIN preorder_products pp ON pp.id=pr.preorder_product_id
        JOIN customers c ON c.id=pr.customer_id
        WHERE pp.preorder_campaign_id=$1 AND pr.status IN ('REQUESTED','ALLOCATED')
        GROUP BY c.id,c.name,c.discord_user_id
        ORDER BY c.name
      `,[campaign.id]);

      let queued=0,suppressed=0;
      for(const row of customers.rows){
        const items=Array.isArray(row.items)?row.items:[];
        const lines=items.map(x=>'- '+x.item+(x.sku?' ('+x.sku+')':'')+' x'+x.qty);
        const message='Your Hobby Corner GW preorder for '+campaign.name+':\n'+lines.join('\n')+
          '\n\nThe store order has been submitted. We will contact you again when items arrive.';
        if(row.discord_user_id){
          await client.query(`
            INSERT INTO notifications
              (preorder_campaign_id,customer_id,channel,recipient,status,message)
            VALUES ($1,$2,'DISCORD_GW_ORDER_SUMMARY',$3,'PENDING',$4)
          `,[campaign.id,row.customer_id,String(row.discord_user_id),message]);
          queued++;
        }else{
          await client.query(`
            INSERT INTO notifications
              (preorder_campaign_id,customer_id,channel,status,message,suppression_reason,suppressed_at)
            VALUES ($1,$2,'DISCORD_GW_ORDER_SUMMARY','SUPPRESSED',$3,'Customer has no linked Discord user ID',now())
          `,[campaign.id,row.customer_id,message]);
          suppressed++;
        }
      }

      await client.query('COMMIT');
      res.json({
        campaign_id:campaign.id,
        submitted_products:products.rows.length,
        total_units:totalUnits,
        customer_summaries:queued,
        customer_summaries_suppressed:suppressed,
        staff_notification_queued:true
      });
    }catch(error){
      await client.query('ROLLBACK');
      res.status(400).json({error:error.message});
    }finally{client.release()}
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

  router.patch('/items/:id/notes', requireDb, async (req,res)=>{
    const notes=req.body?.notes==null?null:String(req.body.notes).trim()||null;
    const changedBy=String(req.body?.changed_by||'ordering-web').trim()||'ordering-web';
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      const current=await client.query('SELECT notes FROM special_order_items WHERE id=$1 FOR UPDATE',[req.params.id]);
      if(!current.rows[0]){await client.query('ROLLBACK');return res.status(404).json({error:'Special Order line not found.'});}
      const oldNotes=current.rows[0].notes||null;
      const {rows}=await client.query('UPDATE special_order_items SET notes=$1,updated_at=now() WHERE id=$2 RETURNING *',[notes,req.params.id]);
      await client.query(
        'INSERT INTO special_order_item_activity (special_order_item_id,activity_type,message,old_value,new_value,changed_by) VALUES ($1,\'NOTE\',$2,$3,$4,$5)',
        [req.params.id,notes?'Note saved':'Note cleared',oldNotes,notes,changedBy]
      );
      await client.query('COMMIT');
      res.json(rows[0]);
    }catch(error){
      await client.query('ROLLBACK');
      res.status(400).json({error:error.message});
    }finally{client.release()}
  });
  router.get('/items/:id/activity', requireDb, async (req,res)=>{
    const itemResult=await pool.query('SELECT id,notes,created_at,updated_at FROM special_order_items WHERE id=$1',[req.params.id]);
    const item=itemResult.rows[0];
    if(!item)return res.status(404).json({error:'Special Order line not found.'});
    const statusHistory=await pool.query(
      `SELECT 'STATUS' AS activity_type,
              COALESCE(note,'Status changed from '||COALESCE(old_status,'—')||' to '||new_status) AS message,
              old_status AS old_value,new_status AS new_value,changed_by,changed_at AS created_at
       FROM order_status_history
       WHERE special_order_item_id=$1`,
      [req.params.id]
    );
    const other=await pool.query(
      `SELECT activity_type,message,old_value,new_value,changed_by,created_at
       FROM special_order_item_activity
       WHERE special_order_item_id=$1`,
      [req.params.id]
    );
    const activities=[...statusHistory.rows,...other.rows];
    const hasNoteHistory=other.rows.some(x=>x.activity_type==='NOTE');
    if(item.notes && !hasNoteHistory){
      activities.push({
        activity_type:'NOTE',
        message:'Existing note snapshot (exact original note time unavailable)',
        old_value:null,new_value:item.notes,changed_by:null,created_at:item.updated_at||item.created_at
      });
    }
    activities.sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));
    res.json({item_id:item.id,activities});
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

  async function syncLightspeedSuppliers(){
    const listed=await lightspeedVersionedFetch(lightspeedDomain,lightspeedToken,'/suppliers?page_size=1000');
    const source=Array.isArray(listed?.data)?listed.data:(Array.isArray(listed)?listed:[]);
    const rows=[];
    for(const s of source){
      if(!s?.id||!String(s.name||'').trim())continue;
      const result=await pool.query(
        `INSERT INTO suppliers (name,lightspeed_supplier_id,is_active,updated_at)
         VALUES ($1,$2,true,now())
         ON CONFLICT (name) DO UPDATE SET
           lightspeed_supplier_id=EXCLUDED.lightspeed_supplier_id,is_active=true,updated_at=now()
         RETURNING *`,
        [String(s.name).trim(),String(s.id)]
      );
      rows.push({...result.rows[0],lightspeed:s});
    }
    return rows.sort((a,b)=>String(a.name).localeCompare(String(b.name)));
  }

  async function getLightspeedOpenPurchaseOrders(){
    const listed=await lightspeedVersionedFetch(lightspeedDomain,lightspeedToken,'/purchase_orders?page_size=1000');
    const all=Array.isArray(listed?.data)?listed.data:(Array.isArray(listed)?listed:[]);
    const current=all.filter(po=>!['RECEIVED','CANCELLED','CLOSED'].includes(String(po.status||'').toUpperCase()));
    const orders=[];
    for(const po of current){
      let items=[];
      try{
        const lineResponse=await lightspeedVersionedFetch(lightspeedDomain,lightspeedToken,'/purchase_orders/'+encodeURIComponent(po.id)+'/line_items?page_size=1000');
        items=Array.isArray(lineResponse?.data)?lineResponse.data:(Array.isArray(lineResponse)?lineResponse:[]);
      }catch(error){
        console.warn('[special-orders] Lightspeed PO line read failed',po.id,error.message);
      }
      orders.push({...po,line_items:items});
    }
    return orders;
  }

  function lsPoReference(po){
    return String(po.reference||po.order_number||po.number||po.name||po.id||'').trim();
  }
  function lightspeedCustomerId(sale){
    return String(sale?.customer?.id||sale?.customer_id||sale?.customerId||'').trim();
  }

  function lightspeedProductId(line){
    return String(line?.product?.id||line?.product_id||line?.productId||line?.product?.product_id||'').trim();
  }

  function lightspeedProductImage(product){
    const direct=product?.image_url||product?.image?.url||product?.primary_image?.url||product?.primary_image_url||null;
    if(direct)return direct;
    const images=Array.isArray(product?.images)?product.images:[];
    return images.find(x=>x?.url)?.url||images.find(x=>x?.src)?.src||null;
  }

  function lightspeedCustomerSummary(customer){
    if(!customer)return null;
    const first=String(customer.first_name||customer.firstname||'').trim();
    const last=String(customer.last_name||customer.lastname||'').trim();
    const name=[first,last].filter(Boolean).join(' ')||String(customer.name||customer.display_name||'').trim()||'Lightspeed customer';
    const email=customer.email||customer.email_address||customer.contact?.email||null;
    const phone=customer.phone||customer.phone_number||customer.mobile||customer.contact?.phone||null;
    return {id:customer.id||null,name,email,phone};
  }

  async function getLightspeedCustomer(customerId,cache){
    if(!customerId)return null;
    if(cache.has(customerId))return cache.get(customerId);
    try{
      const response=await lightspeedVersionedFetch(lightspeedDomain,lightspeedToken,'/customers/'+encodeURIComponent(customerId));
      const customer=response?.data||response||null;
      const summary=lightspeedCustomerSummary(customer);
      cache.set(customerId,summary);
      return summary;
    }catch(error){
      console.warn('[special-orders] Lightspeed customer read failed',customerId,error.message);
      cache.set(customerId,null);
      return null;
    }
  }

  async function getLightspeedProduct(productId,cache){
    if(!productId)return null;
    if(cache.has(productId))return cache.get(productId);
    try{
      const response=await lightspeedVersionedFetch(lightspeedDomain,lightspeedToken,'/products/'+encodeURIComponent(productId));
      const product=response?.data||response||null;
      cache.set(productId,product);
      return product;
    }catch(error){
      console.warn('[special-orders] Lightspeed product read failed',productId,error.message);
      cache.set(productId,null);
      return null;
    }
  }
  router.patch('/items/:id/routing', requireDb, async (req,res)=>{
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      const current=await client.query('SELECT * FROM special_order_items WHERE id=$1 FOR UPDATE',[req.params.id]);
      const item=current.rows[0];
      if(!item){await client.query('ROLLBACK');return res.status(404).json({error:'Special Order line not found.'});}
      const attached=await client.query('SELECT supplier_order_id FROM supplier_order_items WHERE special_order_item_id=$1 LIMIT 1',[req.params.id]);
      if(attached.rows[0]){await client.query('ROLLBACK');return res.status(409).json({error:'Routing cannot be changed after the line is attached to supplier order #'+attached.rows[0].supplier_order_id+'.'});}
      let supplierId=req.body?.preferred_supplier_id===undefined?item.preferred_supplier_id:(req.body.preferred_supplier_id||null);
      let departmentId=req.body?.sourcing_department_id===undefined?item.sourcing_department_id:(req.body.sourcing_department_id||null);
      if(supplierId){
        const s=await client.query('SELECT id FROM suppliers WHERE id=$1 AND is_active=true',[supplierId]);
        if(!s.rows[0]){await client.query('ROLLBACK');return res.status(400).json({error:'Preferred supplier is invalid or inactive.'});}
      }
      if(departmentId){
        const d=await client.query('SELECT id FROM sourcing_departments WHERE id=$1 AND is_active=true',[departmentId]);
        if(!d.rows[0]){await client.query('ROLLBACK');return res.status(400).json({error:'Sourcing department is invalid or inactive.'});}
      }
      const {rows}=await client.query(
        'UPDATE special_order_items SET preferred_supplier_id=$1,sourcing_department_id=$2,updated_at=now() WHERE id=$3 RETURNING *',
        [supplierId,departmentId,req.params.id]
      );
      if(String(item.preferred_supplier_id||'')!==String(supplierId||'')){
        const oldSupplier=item.preferred_supplier_id
          ? await client.query('SELECT name FROM suppliers WHERE id=$1',[item.preferred_supplier_id])
          : {rows:[]};
        const newSupplier=supplierId
          ? await client.query('SELECT name FROM suppliers WHERE id=$1',[supplierId])
          : {rows:[]};
        await client.query(
          'INSERT INTO special_order_item_activity (special_order_item_id,activity_type,message,old_value,new_value,changed_by) VALUES ($1,\'SUPPLIER\',$2,$3,$4,$5)',
          [
            item.id,
            supplierId?'Preferred supplier changed':'Preferred supplier cleared',
            oldSupplier.rows[0]?.name||null,
            newSupplier.rows[0]?.name||null,
            req.body?.changed_by||'ordering-web'
          ]
        );
      }
      if(supplierId && String(item.preferred_supplier_id||'')!==String(supplierId)){
        const productInfo=item.product_id
          ? await client.query('SELECT product_category FROM products WHERE id=$1',[item.product_id])
          : {rows:[]};
        await client.query(
          'INSERT INTO supplier_routing_history (special_order_item_id,product_id,product_category,supplier_id,selected_by) VALUES ($1,$2,$3,$4,$5)',
          [item.id,item.product_id||null,productInfo.rows[0]?.product_category||null,supplierId,req.body?.changed_by||'ordering-web']
        );
      }
      if(supplierId){
        await client.query(
          'INSERT INTO special_order_item_suppliers (special_order_item_id,supplier_id,priority) VALUES ($1,$2,1) ON CONFLICT (special_order_item_id,supplier_id) DO UPDATE SET priority=LEAST(special_order_item_suppliers.priority,1)',
          [req.params.id,supplierId]
        );
      }
      await client.query('COMMIT');
      res.json(rows[0]);
    }catch(error){await client.query('ROLLBACK');res.status(400).json({error:error.message});}
    finally{client.release()}
  });
  router.get('/ordering/work-queue', requireDb, async (req,res)=>{
    const view=String(req.query.view||'general').toLowerCase();
    const rawStatus=String(req.query.status||'ALL').trim().toUpperCase();
    const statuses=rawStatus==='ALL'?null:rawStatus.split(',').map(x=>x.trim()).filter(Boolean);
    const params=[view];
    const statusSql=statuses?.length?'WHERE i.status = ANY($2::text[])':'';
    if(statuses?.length)params.push(statuses);
    const result=await pool.query(
      `SELECT i.id,i.special_order_id,i.product_id,i.requested_name,i.requested_sku,i.requested_upc,i.quantity,i.status,
              i.notes,i.created_at,i.updated_at,i.ordered_at,i.preferred_supplier_id,i.sourcing_department_id,
              o.customer_id,c.name AS customer_name,p.lightspeed_product_id,p.product_category,
              ps.name AS preferred_supplier_name,ps.lightspeed_supplier_id AS preferred_lightspeed_supplier_id,
              d.name AS category_name,COALESCE(sp.supplier_sku,i.requested_sku) AS supplier_sku,
              sp.supply_price AS supplier_cost
       FROM special_order_items i
       JOIN special_orders o ON o.id=i.special_order_id
       LEFT JOIN customers c ON c.id=o.customer_id
       LEFT JOIN suppliers ps ON ps.id=i.preferred_supplier_id
       LEFT JOIN products p ON p.id=i.product_id
       LEFT JOIN sourcing_departments d ON d.id=i.sourcing_department_id
       LEFT JOIN supplier_products sp ON sp.product_id=i.product_id AND sp.supplier_id=i.preferred_supplier_id
       ${statusSql}
       ORDER BY CASE WHEN $1='supplier' THEN COALESCE(ps.name,'ZZZ Unassigned') ELSE '' END,
                CASE WHEN $1='category' THEN COALESCE(p.product_category,d.name,'ZZZ Unassigned') ELSE '' END,
                i.created_at,i.id`,
      params
    );
    let purchaseOrders=[];
    try{purchaseOrders=await getLightspeedOpenPurchaseOrders()}catch(error){console.warn('[special-orders] PO annotation unavailable:',error.message)}
    const productPo=new Map();
    for(const po of purchaseOrders){
      const ref=lsPoReference(po);
      for(const line of po.line_items||[]){
        const pid=String(line.product_id||line.product?.id||line.product?.product_id||'');
        if(!pid)continue;
        if(!productPo.has(pid))productPo.set(pid,[]);
        productPo.get(pid).push({purchase_order_id:po.id,purchase_order_number:ref,status:po.status,supplier_id:po.supplier_id||po.supplier?.id||null});
      }
    }
    const rows=result.rows.map(row=>{
      const matches=row.lightspeed_product_id?productPo.get(String(row.lightspeed_product_id))||[]:[];
      return {...row,on_current_purchase_order:matches.length>0,purchase_orders:matches};
    });
    res.json({view,status:rawStatus,rows,purchase_order_count:purchaseOrders.length});
  });
  router.get('/ordering/lightspeed-context', requireDb, async (req,res)=>{
    try{
      const [suppliers,purchaseOrders]=await Promise.all([syncLightspeedSuppliers(),getLightspeedOpenPurchaseOrders()]);
      const poByProduct=new Map();
      const poProductIds=new Map();
      for(const po of purchaseOrders){
        const ref=lsPoReference(po);
        const ids=new Set();
        for(const line of po.line_items||[]){
          const pid=lightspeedProductId(line);
          if(!pid)continue;
          ids.add(pid);
          if(!poByProduct.has(pid))poByProduct.set(pid,[]);
          poByProduct.get(pid).push({purchase_order_id:po.id,purchase_order_number:ref,status:po.status,supplier_id:po.supplier_id||po.supplier?.id||null});
        }
        poProductIds.set(String(po.id),ids);
      }

      const localSpecials=await pool.query(
        "SELECT i.id,i.quantity,p.lightspeed_product_id FROM special_order_items i JOIN products p ON p.id=i.product_id WHERE p.lightspeed_product_id IS NOT NULL AND i.status<>'CANCELLED'"
      );
      const enrichedPurchaseOrders=purchaseOrders.map(po=>{
        const ids=poProductIds.get(String(po.id))||new Set();
        const matched=localSpecials.rows.filter(x=>ids.has(String(x.lightspeed_product_id)));
        return {...po,special_order_count:matched.length,special_order_units:matched.reduce((n,x)=>n+Number(x.quantity||0),0)};
      });

      const params=new URLSearchParams({page_size:'100'});
      ['OPEN','STARTED','PICKED','PACKED'].forEach(x=>params.append('fulfillment_state',x));
      let fulfillmentRows=[];
      try{
        const f=await lightspeedVersionedFetch(lightspeedDomain,lightspeedToken,'/fulfillments?'+params.toString());
        fulfillmentRows=Array.isArray(f?.data)?f.data:(Array.isArray(f)?f:[]);
      }catch(error){console.warn('[special-orders] Lightspeed fulfillment read unavailable:',error.message)}

      const saleIds=[...new Set(fulfillmentRows.map(x=>String(x.sale_id||x.sale?.id||'')).filter(Boolean))];
      const customerCache=new Map();
      const productCache=new Map();
      const demand=[];
      for(const saleId of saleIds.slice(0,100)){
        let sale;
        try{
          const response=await lightspeedVersionedFetch(lightspeedDomain,lightspeedToken,'/sales/'+encodeURIComponent(saleId));
          sale=response?.data||response;
        }catch(error){
          console.warn('[special-orders] Lightspeed sale read failed',saleId,error.message);
          continue;
        }
        const customerId=lightspeedCustomerId(sale);
        const customer=await getLightspeedCustomer(customerId,customerCache);
        const embeddedCustomer=lightspeedCustomerSummary(sale?.customer);
        const resolvedCustomer=customer||embeddedCustomer||{id:customerId||null,name:String(sale?.customer_name||'').trim()||'Lightspeed customer',email:null,phone:null};
        const lines=Array.isArray(sale?.line_items)?sale.line_items:[];
        for(const line of lines){
          const productId=lightspeedProductId(line);
          if(!productId)continue;
          const qty=Number(line.quantity||line.count||0);
          if(qty<=0)continue;
          const product=await getLightspeedProduct(productId,productCache);
          const embedded=line.product||{};
          const productName=String(product?.name||embedded?.name||line.name||line.product_name||'').trim()||'Product';
          const sku=product?.sku||embedded?.sku||line.sku||null;
          const upc=(Array.isArray(product?.product_codes)?product.product_codes.find(x=>x?.code)?.code:null)||product?.upc||embedded?.upc||line.upc||null;
          const imageUrl=lightspeedProductImage(product)||lightspeedProductImage(embedded);
          const localMatch=await pool.query(
            "SELECT i.id,i.status,i.notes,i.special_order_id,c.name AS customer_name FROM products p JOIN special_order_items i ON i.product_id=p.id JOIN special_orders o ON o.id=i.special_order_id LEFT JOIN customers c ON c.id=o.customer_id WHERE p.lightspeed_product_id=$1 AND i.status<>'CANCELLED' ORDER BY i.created_at",
            [productId]
          );
          demand.push({
            source:'LIGHTSPEED_FULFILLMENT',
            sale_id:saleId,invoice_number:sale.invoice_number||sale.receipt_number||sale.id,
            customer_id:resolvedCustomer.id,customer_name:resolvedCustomer.name,customer_email:resolvedCustomer.email,customer_phone:resolvedCustomer.phone,
            product_id:productId,item_description:productName,sku,upc,image_url:imageUrl,quantity:qty,
            purchase_orders:poByProduct.get(productId)||[],on_current_purchase_order:(poByProduct.get(productId)||[]).length>0,
            local_special_order_matches:localMatch.rows,local_special_order_match_count:localMatch.rows.length
          });
        }
      }
      res.json({suppliers,purchase_orders:enrichedPurchaseOrders,lightspeed_demand:demand,fulfillment_count:fulfillmentRows.length});
    }catch(error){
      console.error('[special-orders] ordering Lightspeed context failed:',error);
      res.status(error.status||502).json({error:error.message});
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
    try{
      const rows=await syncLightspeedSuppliers();
      res.json(rows);
    }catch(error){
      console.error('[special-orders] Lightspeed supplier sync failed:',error);
      res.status(error.status||502).json({error:'Could not load the current Lightspeed supplier list: '+error.message});
    }
  });

  router.get('/products/:id/recommended-suppliers', requireDb, async (req,res)=>{
    const productId=Number(req.params.id);
    if(!Number.isFinite(productId))return res.status(400).json({error:'Local product id is required.'});
    let suppliers;
    try{suppliers=await syncLightspeedSuppliers()}catch(error){return res.status(error.status||502).json({error:error.message})}
    const productResult=await pool.query('SELECT id,product_category FROM products WHERE id=$1',[productId]);
    const product=productResult.rows[0];
    if(!product)return res.status(404).json({error:'Product not found.'});
    const history=await pool.query(
      `WITH choices AS (
         SELECT supplier_id,product_id,product_category,selected_at
         FROM supplier_routing_history
         WHERE product_id=$1 OR (COALESCE($2,'')<>'' AND lower(COALESCE(product_category,''))=lower($2))
         UNION ALL
         SELECT i.preferred_supplier_id AS supplier_id,
                i.product_id,
                p.product_category,
                i.updated_at AS selected_at
         FROM special_order_items i
         LEFT JOIN products p ON p.id=i.product_id
         WHERE i.preferred_supplier_id IS NOT NULL
           AND (i.product_id=$1 OR (COALESCE($2,'')<>'' AND lower(COALESCE(p.product_category,''))=lower($2)))
       )
       SELECT supplier_id,
              count(*) FILTER (WHERE product_id=$1)::int AS exact_count,
              count(*) FILTER (WHERE lower(COALESCE(product_category,''))=lower(COALESCE($2,'')))::int AS category_count,
              count(*)::int AS total_count,
              max(selected_at) AS last_selected_at
       FROM choices
       GROUP BY supplier_id`,
      [productId,product.product_category||'']
    );
    const hist=new Map(history.rows.map(x=>[Number(x.supplier_id),x]));
    const direct=await pool.query('SELECT supplier_id,priority FROM supplier_products WHERE product_id=$1 AND is_orderable=true',[productId]);
    const directMap=new Map(direct.rows.map(x=>[Number(x.supplier_id),Number(x.priority||1)]));
    const ranked=suppliers.map(s=>{
      const h=hist.get(Number(s.id))||{};
      const exact=Number(h.exact_count||0),category=Number(h.category_count||0),total=Number(h.total_count||0);
      const directPriority=directMap.get(Number(s.id));
      const score=(directPriority?100-Math.min(40,directPriority*5):0)+(exact*30)+(category*8)+(total*2);
      const reasons=[];
      if(directPriority)reasons.push('Known supplier for this product');
      if(exact)reasons.push('Chosen '+exact+' time'+(exact===1?'':'s')+' for this product');
      if(category)reasons.push('Chosen '+category+' time'+(category===1?'':'s')+' for '+(product.product_category||'this category'));
      return {...s,recommendation_score:score,recommendation_reason:reasons.join(' · ')||'No selection history yet',exact_history_count:exact,category_history_count:category,last_selected_at:h.last_selected_at||null};
    }).sort((a,b)=>Number(b.recommendation_score)-Number(a.recommendation_score)||String(a.name).localeCompare(String(b.name)));
    res.json(ranked);
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
        if (item.special_order_item_id) {
          const attached = await client.query(
            'SELECT supplier_order_id FROM supplier_order_items WHERE special_order_item_id=$1 LIMIT 1',
            [item.special_order_item_id]
          );
          if (attached.rows[0]) {
            throw new Error('Special Order line '+item.special_order_item_id+' is already attached to supplier order #'+attached.rows[0].supplier_order_id+'.');
          }
        }
        let specialQty = Math.max(0, Number(item.special_order_quantity || 0));
        if (item.special_order_item_id) {
          const linkedQty = await client.query('SELECT quantity FROM special_order_items WHERE id=$1',[item.special_order_item_id]);
          if (!linkedQty.rows[0]) throw new Error('Special Order line '+item.special_order_item_id+' was not found.');
          specialQty = Math.max(1, Number(linkedQty.rows[0].quantity || 1));
        }
        const floorQty = Math.max(0, Number(item.floor_quantity ?? Math.max(0, qty - specialQty)));
        const totalQty = specialQty + floorQty;
        await client.query(`
          INSERT INTO supplier_order_items
            (supplier_order_id,product_id,supplier_product_id,quantity,unit_cost,
             special_order_item_id,special_order_quantity,floor_quantity,
             placeholder_name,placeholder_sku,source_url)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        `, [order.rows[0].id, item.product_id || null, item.supplier_product_id || null, totalQty,
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

  router.get('/supplier-orders', requireDb, async (req,res)=>{
    const status=String(req.query.status||'').trim().toUpperCase();
    const params=[];
    let where='';
    if(status){params.push(status);where='WHERE so.status=$1';}
    const sql="SELECT so.*,s.name AS supplier_name,s.lightspeed_supplier_id,"+
      "count(soi.id)::int AS line_count,COALESCE(sum(soi.quantity),0)::int AS unit_count,"+
      "COALESCE(sum(soi.special_order_quantity),0)::int AS special_order_units,"+
      "COALESCE(sum(soi.floor_quantity),0)::int AS floor_units,"+
      "COALESCE(sum(soi.quantity*COALESCE(soi.unit_cost,0)),0)::numeric(12,2) AS estimated_cost "+
      "FROM supplier_orders so JOIN suppliers s ON s.id=so.supplier_id "+
      "LEFT JOIN supplier_order_items soi ON soi.supplier_order_id=so.id "+where+
      " GROUP BY so.id,s.id ORDER BY CASE WHEN so.status='DRAFT' THEN 0 ELSE 1 END,so.updated_at DESC,so.id DESC";
    const {rows}=await pool.query(sql,params);
    res.json(rows);
  });

  router.patch('/supplier-orders/:id', requireDb, async (req,res)=>{
    const current=await pool.query('SELECT * FROM supplier_orders WHERE id=$1',[req.params.id]);
    const order=current.rows[0];
    if(!order)return res.status(404).json({error:'Supplier order not found.'});
    if(String(order.status).toUpperCase()!=='DRAFT')return res.status(409).json({error:'Only draft supplier orders can be edited.'});
    const supplierOrderNumber=req.body?.supplier_order_number===undefined?order.supplier_order_number:(String(req.body.supplier_order_number||'').trim()||null);
    const notes=req.body?.notes===undefined?order.notes:(String(req.body.notes||'').trim()||null);
    const expectedAt=req.body?.expected_at===undefined?order.expected_at:(req.body.expected_at||null);
    const {rows}=await pool.query(
      'UPDATE supplier_orders SET supplier_order_number=$1,notes=$2,expected_at=$3,updated_at=now() WHERE id=$4 RETURNING *',
      [supplierOrderNumber,notes,expectedAt,req.params.id]
    );
    res.json(rows[0]);
  });

  router.patch('/supplier-order-items/:id', requireDb, async (req,res)=>{
    const current=await pool.query(
      'SELECT soi.*,so.status AS order_status FROM supplier_order_items soi JOIN supplier_orders so ON so.id=soi.supplier_order_id WHERE soi.id=$1',
      [req.params.id]
    );
    const line=current.rows[0];
    if(!line)return res.status(404).json({error:'Supplier-order line not found.'});
    if(String(line.order_status).toUpperCase()!=='DRAFT')return res.status(409).json({error:'Only draft supplier-order lines can be edited.'});
    let specialQty=req.body?.special_order_quantity==null?Number(line.special_order_quantity||0):Math.max(0,Math.floor(Number(req.body.special_order_quantity)||0));
    if(line.special_order_item_id){
      const linked=await pool.query('SELECT quantity FROM special_order_items WHERE id=$1',[line.special_order_item_id]);
      if(!linked.rows[0])return res.status(409).json({error:'Linked Special Order line no longer exists.'});
      specialQty=Math.max(1,Number(linked.rows[0].quantity||1));
    }
    const floorQty=req.body?.floor_quantity==null?Number(line.floor_quantity||0):Math.max(0,Math.floor(Number(req.body.floor_quantity)||0));
    const quantity=specialQty+floorQty;
    const unitCost=req.body?.unit_cost===undefined?line.unit_cost:(req.body.unit_cost==null||req.body.unit_cost===''?null:Math.max(0,Number(req.body.unit_cost)||0));
    const {rows}=await pool.query(
      'UPDATE supplier_order_items SET quantity=$1,special_order_quantity=$2,floor_quantity=$3,unit_cost=$4 WHERE id=$5 RETURNING *',
      [quantity,specialQty,floorQty,unitCost,req.params.id]
    );
    await pool.query('UPDATE supplier_orders SET updated_at=now() WHERE id=$1',[line.supplier_order_id]);
    res.json(rows[0]);
  });

  router.delete('/supplier-order-items/:id', requireDb, async (req,res)=>{
    const current=await pool.query(
      'SELECT soi.*,so.status AS order_status FROM supplier_order_items soi JOIN supplier_orders so ON so.id=soi.supplier_order_id WHERE soi.id=$1',
      [req.params.id]
    );
    const line=current.rows[0];
    if(!line)return res.status(404).json({error:'Supplier-order line not found.'});
    if(String(line.order_status).toUpperCase()!=='DRAFT')return res.status(409).json({error:'Only draft supplier-order lines can be removed.'});
    if(Number(line.quantity_received||0)>0)return res.status(409).json({error:'A line with received quantity cannot be removed.'});
    await pool.query('DELETE FROM supplier_order_items WHERE id=$1',[req.params.id]);
    await pool.query('UPDATE supplier_orders SET updated_at=now() WHERE id=$1',[line.supplier_order_id]);
    res.json({ok:true,supplier_order_id:line.supplier_order_id});
  });
  router.post('/supplier-orders/:id/items', requireDb, async (req,res)=>{
    const items=Array.isArray(req.body?.items)?req.body.items:[];
    if(!items.length)return res.status(400).json({error:'At least one item is required.'});
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      const orderResult=await client.query('SELECT * FROM supplier_orders WHERE id=$1 FOR UPDATE',[req.params.id]);
      const order=orderResult.rows[0];
      if(!order){await client.query('ROLLBACK');return res.status(404).json({error:'Supplier order not found.'});}
      if(String(order.status).toUpperCase()!=='DRAFT'){await client.query('ROLLBACK');return res.status(409).json({error:'Items can only be added to a draft supplier order.'});}
      let added=0;
      for(const item of items){
        const qty=Math.max(0,Math.floor(Number(item.quantity)||0));
        if(qty<=0)continue;
        if(item.special_order_item_id){
          const soi=await client.query('SELECT preferred_supplier_id FROM special_order_items WHERE id=$1',[item.special_order_item_id]);
          if(!soi.rows[0])throw new Error('Special Order line '+item.special_order_item_id+' was not found.');
          if(soi.rows[0].preferred_supplier_id && Number(soi.rows[0].preferred_supplier_id)!==Number(order.supplier_id))throw new Error('Special Order line '+item.special_order_item_id+' belongs to a different preferred supplier.');
          const attached=await client.query('SELECT supplier_order_id FROM supplier_order_items WHERE special_order_item_id=$1 LIMIT 1',[item.special_order_item_id]);
          if(attached.rows[0])throw new Error('Special Order line '+item.special_order_item_id+' is already attached to supplier order #'+attached.rows[0].supplier_order_id+'.');
        }
        let specialQty=Math.max(0,Math.floor(Number(item.special_order_quantity)||0));
        if(item.special_order_item_id){
          const linkedQty=await client.query('SELECT quantity FROM special_order_items WHERE id=$1',[item.special_order_item_id]);
          specialQty=Math.max(1,Number(linkedQty.rows[0]?.quantity||1));
        }
        const floorQty=Math.max(0,Math.floor(Number(item.floor_quantity??Math.max(0,qty-specialQty))||0));
        await client.query(
          'INSERT INTO supplier_order_items (supplier_order_id,product_id,supplier_product_id,quantity,unit_cost,special_order_item_id,special_order_quantity,floor_quantity,placeholder_name,placeholder_sku,source_url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
          [order.id,item.product_id||null,item.supplier_product_id||null,specialQty+floorQty,item.unit_cost??null,item.special_order_item_id||null,specialQty,floorQty,item.placeholder_name||null,item.placeholder_sku||null,item.source_url||null]
        );
        added++;
      }
      await client.query('UPDATE supplier_orders SET updated_at=now() WHERE id=$1',[order.id]);
      await client.query('COMMIT');
      res.status(201).json({order_id:order.id,added});
    }catch(error){await client.query('ROLLBACK');res.status(400).json({error:error.message});}
    finally{client.release()}
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
    if (order.lightspeed_consignment_id || String(order.lightspeed_sync_status||'').toUpperCase()==='SYNCED') {
      return res.status(409).json({
        error:'This supplier order is already linked to a Lightspeed purchase order and cannot be pushed again.',
        lightspeed_consignment_id:order.lightspeed_consignment_id||null
      });
    }
    if (String(order.status||'DRAFT').toUpperCase()!=='DRAFT') {
      return res.status(409).json({ error:'Only draft supplier orders can be pushed to Lightspeed.' });
    }

    const itemsResult = await pool.query(`
      SELECT soi.*, p.lightspeed_product_id
      FROM supplier_order_items soi LEFT JOIN products p ON p.id=soi.product_id
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
      if (!consignment?.id) throw Object.assign(new Error('Lightspeed did not return a purchase-order id.'),{status:502});
      await pool.query(
        "UPDATE supplier_orders SET lightspeed_consignment_id=$1,lightspeed_sync_status='PENDING_LINES',updated_at=now() WHERE id=$2",
        [consignment.id,req.params.id]
      );

      const bulk = itemsResult.rows.map(x => ({
        product_id:x.lightspeed_product_id,
        count:Number(x.quantity),
        ...(x.unit_cost != null ? { cost:Number(x.unit_cost) } : {})
      }));
      await lightspeedFetch(lightspeedDomain, lightspeedToken, `/consignments/${consignment.id}/bulk`, {
        method:'POST', body:JSON.stringify({ data: bulk })
      });

      const client=await pool.connect();
      let updated;
      try{
        await client.query('BEGIN');
        updated=await client.query(
          "UPDATE supplier_orders SET lightspeed_consignment_id=$1,lightspeed_sync_status='SYNCED',status='ORDERED',ordered_at=COALESCE(ordered_at,now()),updated_at=now() WHERE id=$2 RETURNING *",
          [consignment.id,req.params.id]
        );
        const linked=await client.query(
          'SELECT DISTINCT special_order_item_id FROM supplier_order_items WHERE supplier_order_id=$1 AND special_order_item_id IS NOT NULL',
          [req.params.id]
        );
        for(const row of linked.rows){
          const oldResult=await client.query('SELECT status FROM special_order_items WHERE id=$1 FOR UPDATE',[row.special_order_item_id]);
          const oldStatus=oldResult.rows[0]?.status;
          if(oldStatus&&['OOS','READY_TO_ORDER','BACKORDERED'].includes(String(oldStatus).toUpperCase())){
            await client.query("UPDATE special_order_items SET status='ORDERED',ordered_at=COALESCE(ordered_at,now()),updated_at=now() WHERE id=$1",[row.special_order_item_id]);
            await client.query(
              "INSERT INTO order_status_history (special_order_item_id,old_status,new_status,note,changed_by) VALUES ($1,$2,'ORDERED',$3,'ordering-web')",
              [row.special_order_item_id,oldStatus,'Supplier order pushed to Lightspeed PO '+consignment.id]
            );
          }
        }
        await client.query('COMMIT');
      }catch(txError){
        await client.query('ROLLBACK');
        throw txError;
      }finally{client.release()}
      res.json({order:updated.rows[0],lightspeed:consignment});
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

  router.get('/ordering/lightspeed-purchase-orders/:id/receiving-preview', requireDb, async (req,res)=>{
    try{
      const purchaseOrders=await getLightspeedOpenPurchaseOrders();
      const po=purchaseOrders.find(x=>String(x.id)===String(req.params.id));
      if(!po)return res.status(404).json({error:'Current Lightspeed purchase order not found.'});
      const poRef=lsPoReference(po);
      const lines=[];
      for(const line of po.line_items||[]){
        const lsProductId=lightspeedProductId(line);
        if(!lsProductId)continue;
        const localProduct=await pool.query('SELECT id,name,sku,upc FROM products WHERE lightspeed_product_id=$1 LIMIT 1',[lsProductId]);
        const product=localProduct.rows[0]||null;
        let waiting=[];
        if(product){
          const result=await pool.query(
            "SELECT i.id AS special_order_item_id,i.quantity,i.status,i.created_at,"+
            "o.customer_id,c.name AS customer_name,c.phone AS customer_phone,c.email AS customer_email,c.discord_user_id,"+
            "COALESCE((SELECT sum(a.quantity)::int FROM inventory_allocations a WHERE a.special_order_item_id=i.id AND a.released_at IS NULL),0) AS current_allocated,"+
            "COALESCE(r.allocated_quantity,0)::int AS this_po_allocated "+
            "FROM special_order_items i "+
            "JOIN special_orders o ON o.id=i.special_order_id "+
            "LEFT JOIN customers c ON c.id=o.customer_id "+
            "LEFT JOIN lightspeed_po_receipt_allocations r ON r.special_order_item_id=i.id AND r.lightspeed_purchase_order_id=$2 "+
            "WHERE i.product_id=$1 AND i.status NOT IN ('CANCELLED','COMPLETED') "+
            "ORDER BY i.created_at,i.id",
            [product.id,String(po.id)]
          );
          waiting=result.rows.map(x=>({...x,remaining_needed:Math.max(0,Number(x.quantity||0)-Number(x.current_allocated||0))}));
        }
        const orderedQty=Number(line.quantity ?? line.count ?? line.ordered_quantity ?? line.order_quantity ?? 0)||0;
        const lsReceivedQty=Number(line.received_quantity ?? line.quantity_received ?? line.received_count ?? line.received ?? 0)||0;
        lines.push({
          line_id:line.id||null,lightspeed_product_id:lsProductId,
          product_name:product?.name||line.product?.name||line.name||'Product',
          sku:product?.sku||line.product?.sku||line.sku||null,
          ordered_quantity:orderedQty,lightspeed_received_quantity:lsReceivedQty,
          waiting_special_orders:waiting,
          waiting_special_order_count:waiting.filter(x=>x.remaining_needed>0).length
        });
      }
      res.json({purchase_order:{id:po.id,reference:poRef,status:po.status,supplier_id:po.supplier_id||po.supplier?.id||null,updated_at:po.updated_at||null},lines});
    }catch(error){res.status(error.status||502).json({error:error.message});}
  });

  router.post('/ordering/lightspeed-purchase-orders/:id/receive-special-orders', requireDb, async (req,res)=>{
    const allocations=Array.isArray(req.body?.allocations)?req.body.allocations:[];
    const receivedBy=String(req.body?.received_by||'ordering-web').trim()||'ordering-web';
    if(!allocations.length)return res.status(400).json({error:'At least one Special Order allocation is required.'});
    let purchaseOrders;
    try{purchaseOrders=await getLightspeedOpenPurchaseOrders()}catch(error){return res.status(error.status||502).json({error:error.message})}
    const po=purchaseOrders.find(x=>String(x.id)===String(req.params.id));
    if(!po)return res.status(404).json({error:'Current Lightspeed purchase order not found.'});
    const poRef=lsPoReference(po);
    const poProductIds=new Set((po.line_items||[]).map(l=>lightspeedProductId(l)).filter(Boolean));
    const poReceivedByProduct=new Map();
    for(const line of po.line_items||[]){
      const pid=lightspeedProductId(line);
      if(!pid)continue;
      const received=Number(line.received_quantity ?? line.quantity_received ?? line.received_count ?? line.received ?? 0)||0;
      poReceivedByProduct.set(String(pid),Math.max(Number(poReceivedByProduct.get(String(pid))||0),received));
    }
    const db=await pool.connect();
    try{
      await db.query('BEGIN');
      const outcomes=[];
      const proposedProductTotals=new Map();
      for(const a of allocations){
        const itemId=Number(a.special_order_item_id);
        const target=Math.max(0,Math.floor(Number(a.target_allocated_quantity)||0));
        if(!Number.isFinite(itemId)||itemId<=0)continue;
        const itemResult=await db.query(
          "SELECT i.id,i.product_id,i.quantity,i.status,i.requested_name,p.lightspeed_product_id,"+
          "o.customer_id,c.name AS customer_name,c.phone,c.email,c.discord_user_id "+
          "FROM special_order_items i JOIN products p ON p.id=i.product_id "+
          "JOIN special_orders o ON o.id=i.special_order_id LEFT JOIN customers c ON c.id=o.customer_id "+
          "WHERE i.id=$1 FOR UPDATE OF i",
          [itemId]
        );
        const item=itemResult.rows[0];
        if(!item)throw new Error('Special Order line '+itemId+' was not found.');
        if(!item.lightspeed_product_id||!poProductIds.has(String(item.lightspeed_product_id)))throw new Error('Special Order line '+itemId+' is not a product on Lightspeed PO '+poRef+'.');
        const prior=await db.query('SELECT * FROM lightspeed_po_receipt_allocations WHERE lightspeed_purchase_order_id=$1 AND special_order_item_id=$2 FOR UPDATE',[String(po.id),itemId]);
        const previous=Number(prior.rows[0]?.allocated_quantity||0);
        if(target<previous)throw new Error('Received target for Special Order line '+itemId+' cannot be reduced below '+previous+'.');

        const productKey=String(item.lightspeed_product_id);
        if(!proposedProductTotals.has(productKey)){
          const existingProductTotal=await db.query(
            'SELECT COALESCE(sum(allocated_quantity),0)::int AS qty FROM lightspeed_po_receipt_allocations WHERE lightspeed_purchase_order_id=$1 AND lightspeed_product_id=$2',
            [String(po.id),productKey]
          );
          proposedProductTotals.set(productKey,Number(existingProductTotal.rows[0].qty||0));
        }
        const currentProductTotal=Number(proposedProductTotals.get(productKey)||0);
        const proposedProductTotal=currentProductTotal-previous+target;
        const reportedReceived=Number(poReceivedByProduct.get(productKey)||0);
        if(reportedReceived>0 && proposedProductTotal>reportedReceived){
          throw new Error(
            'Receiving allocation for '+item.requested_name+' would allocate '+proposedProductTotal+
            ' unit(s) from PO '+poRef+' but Lightspeed reports only '+reportedReceived+' received for that product.'
          );
        }
        proposedProductTotals.set(productKey,proposedProductTotal);

        const allAllocated=await db.query('SELECT COALESCE(sum(quantity),0)::int AS qty FROM inventory_allocations WHERE special_order_item_id=$1 AND released_at IS NULL',[itemId]);
        const currentlyAllocated=Number(allAllocated.rows[0].qty||0);
        const remainingBefore=Math.max(0,Number(item.quantity||0)-currentlyAllocated);
        const delta=Math.min(target-previous,remainingBefore);
        if(prior.rows[0]){
          await db.query(
            "UPDATE lightspeed_po_receipt_allocations SET allocated_quantity=$1,received_by=$2,"+
            "first_received_at=COALESCE(first_received_at,CASE WHEN $1>0 THEN now() ELSE NULL END),updated_at=now() WHERE id=$3",
            [previous+delta,receivedBy,prior.rows[0].id]
          );
        }else{
          await db.query(
            "INSERT INTO lightspeed_po_receipt_allocations "+
            "(lightspeed_purchase_order_id,lightspeed_purchase_order_reference,lightspeed_product_id,special_order_item_id,allocated_quantity,received_by,first_received_at) "+
            "VALUES ($1,$2,$3,$4,$5,$6,CASE WHEN $5>0 THEN now() ELSE NULL END)",
            [String(po.id),poRef,String(item.lightspeed_product_id),itemId,delta,receivedBy]
          );
        }
        if(delta>0)await db.query('INSERT INTO inventory_allocations (special_order_item_id,product_id,quantity) VALUES ($1,$2,$3)',[itemId,item.product_id,delta]);
        const newTotal=currentlyAllocated+delta;
        const isReady=newTotal>=Number(item.quantity||0);
        if(isReady && !['RECEIVED','HELD','CUSTOMER_NOTIFIED','COMPLETED'].includes(String(item.status).toUpperCase())){
          const oldStatus=item.status;
          await db.query("UPDATE special_order_items SET status='RECEIVED',received_at=COALESCE(received_at,now()),updated_at=now() WHERE id=$1",[itemId]);
          await db.query("INSERT INTO order_status_history (special_order_item_id,old_status,new_status,note,changed_by) VALUES ($1,$2,'RECEIVED',$3,$4)",[itemId,oldStatus,'Received from Lightspeed PO '+poRef,receivedBy]);
          const recipient=item.discord_user_id||item.email||item.phone||null;
          await db.query(
            "INSERT INTO notifications (special_order_item_id,customer_id,channel,recipient,status,message) "+
            "VALUES ($1,$2,'READY_REVIEW',$3,'PENDING',$4) "+
            "ON CONFLICT (special_order_item_id,channel) WHERE special_order_item_id IS NOT NULL AND channel='READY_REVIEW' AND status IN ('PENDING','QUEUED') "+
            "DO UPDATE SET recipient=EXCLUDED.recipient,message=EXCLUDED.message,error=NULL",
            [itemId,item.customer_id,recipient,(item.customer_name||'Customer')+' — '+item.requested_name+' is received and ready for notification review.']
          );
        }
        outcomes.push({special_order_item_id:itemId,previous_po_allocated:previous,added_now:delta,total_allocated:newTotal,required_quantity:Number(item.quantity||0),ready:isReady});
      }
      await db.query('COMMIT');
      res.json({purchase_order_id:String(po.id),purchase_order_reference:poRef,outcomes});
    }catch(error){await db.query('ROLLBACK');res.status(400).json({error:error.message});}
    finally{db.release()}
  });

  router.get('/notifications/ready-review', requireDb, async (req,res)=>{
    const {rows}=await pool.query(
      "SELECT n.id,n.special_order_item_id,n.customer_id,n.recipient,n.status,n.message,n.created_at,"+
      "c.name AS customer_name,c.phone,c.email,c.discord_user_id,i.requested_name,i.quantity,i.status AS item_status,i.received_at "+
      "FROM notifications n JOIN special_order_items i ON i.id=n.special_order_item_id "+
      "LEFT JOIN customers c ON c.id=n.customer_id "+
      "WHERE n.channel='READY_REVIEW' AND n.status='PENDING' ORDER BY n.created_at"
    );
    res.json(rows);
  });

  router.patch('/notifications/:id/review', requireDb, async (req,res)=>{
    const action=String(req.body?.action||'').trim().toUpperCase();
    const reviewedBy=String(req.body?.reviewed_by||'ordering-web').trim()||'ordering-web';
    if(!['ACKNOWLEDGED','SUPPRESSED'].includes(action))return res.status(400).json({error:'action must be ACKNOWLEDGED or SUPPRESSED.'});
    const db=await pool.connect();
    try{
      await db.query('BEGIN');
      const current=await db.query(
        "SELECT n.*,i.requested_name,i.status AS item_status,c.name AS customer_name,c.discord_user_id,c.email,c.phone "+
        "FROM notifications n JOIN special_order_items i ON i.id=n.special_order_item_id "+
        "LEFT JOIN customers c ON c.id=n.customer_id "+
        "WHERE n.id=$1 AND n.channel='READY_REVIEW' FOR UPDATE OF n",
        [req.params.id]
      );
      const review=current.rows[0];
      if(!review){await db.query('ROLLBACK');return res.status(404).json({error:'Ready notification review item not found.'});}
      if(review.status!=='PENDING'){await db.query('ROLLBACK');return res.status(409).json({error:'This notification review has already been handled.'});}

      if(action==='ACKNOWLEDGED'){
        let channel=null,recipient=null;
        if(review.discord_user_id){channel='DISCORD_READY';recipient=review.discord_user_id;}
        else if(review.email){channel='EMAIL_READY';recipient=review.email;}
        else if(review.phone){channel='SMS_READY';recipient=review.phone;}
        else{await db.query('ROLLBACK');return res.status(409).json({error:'Customer has no Discord, email, or phone contact method on file.'});}

        const message=(review.customer_name||'Customer')+', your special order '+review.requested_name+' has arrived and is ready at Hobby Corner.';
        const existingDelivery=await db.query(
          "SELECT id FROM notifications WHERE special_order_item_id=$1 AND channel=$2 AND status IN ('PENDING','QUEUED','SENDING') ORDER BY id DESC LIMIT 1 FOR UPDATE",
          [review.special_order_item_id,channel]
        );
        if(existingDelivery.rows[0]){
          await db.query(
            "UPDATE notifications SET customer_id=$1,recipient=$2,status='QUEUED',message=$3,error=NULL WHERE id=$4",
            [review.customer_id,recipient,message,existingDelivery.rows[0].id]
          );
        }else{
          await db.query(
            "INSERT INTO notifications (special_order_item_id,customer_id,channel,recipient,status,message) VALUES ($1,$2,$3,$4,'QUEUED',$5)",
            [review.special_order_item_id,review.customer_id,channel,recipient,message]
          );
        }
        await db.query("UPDATE notifications SET status='REVIEWED' WHERE id=$1",[review.id]);
        await db.query(
          "INSERT INTO special_order_item_activity (special_order_item_id,activity_type,message,new_value,changed_by) "+
          "VALUES ($1,'OTHER',$2,$3,$4)",
          [review.special_order_item_id,'Customer notification approved for '+channel,channel,reviewedBy]
        );
        await db.query('COMMIT');
        return res.json({ok:true,delivery_channel:channel,recipient});
      }

      const reason=String(req.body?.reason||'Suppressed during employee review').trim();
      await db.query("UPDATE notifications SET status='SUPPRESSED',suppression_reason=$2,suppressed_at=now() WHERE id=$1",[review.id,reason]);
      await db.query(
        "INSERT INTO special_order_item_activity (special_order_item_id,activity_type,message,new_value,changed_by) "+
        "VALUES ($1,'OTHER',$2,'SUPPRESSED',$3)",
        [review.special_order_item_id,reason,reviewedBy]
      );
      await db.query('COMMIT');
      res.json({ok:true,status:'SUPPRESSED'});
    }catch(error){await db.query('ROLLBACK');res.status(400).json({error:error.message});}
    finally{db.release()}
  });

  router.get('/notifications/delivery-queue', requireDb, async (req,res)=>{
    const {rows}=await pool.query(
      "SELECT n.id,n.special_order_item_id,n.customer_id,n.channel,n.recipient,n.status,n.message,n.error,n.created_at,n.sent_at,"+
      "c.name AS customer_name,i.requested_name,i.status AS item_status "+
      "FROM notifications n LEFT JOIN customers c ON c.id=n.customer_id LEFT JOIN special_order_items i ON i.id=n.special_order_item_id "+
      "WHERE n.channel IN ('DISCORD_READY','EMAIL_READY','SMS_READY') AND n.status IN ('QUEUED','SENDING','ERROR') "+
      "ORDER BY n.created_at LIMIT 500"
    );
    res.json(rows);
  });

  router.get('/notifications/discord-delivery', requireDb, async (req,res)=>{
    const limit=Math.max(1,Math.min(50,Number(req.query.limit||20)));
    const {rows}=await pool.query(
      "SELECT n.id,n.special_order_item_id,n.customer_id,n.recipient,n.message,n.created_at,c.name AS customer_name,i.requested_name "+
      "FROM notifications n LEFT JOIN customers c ON c.id=n.customer_id LEFT JOIN special_order_items i ON i.id=n.special_order_item_id "+
      "WHERE n.channel='DISCORD_READY' AND n.status='QUEUED' AND (n.not_before IS NULL OR n.not_before<=now()) "+
      "ORDER BY n.created_at LIMIT $1",
      [limit]
    );
    res.json(rows);
  });

  router.post('/notifications/:id/claim-discord', requireDb, async (req,res)=>{
    const {rows}=await pool.query(
      "UPDATE notifications SET status='SENDING',error=NULL WHERE id=$1 AND channel='DISCORD_READY' AND status='QUEUED' RETURNING *",
      [req.params.id]
    );
    if(!rows[0])return res.status(409).json({error:'Discord notification is no longer available to claim.'});
    res.json(rows[0]);
  });

  router.post('/notifications/:id/complete-discord', requireDb, async (req,res)=>{
    const success=req.body?.success===true;
    const externalId=req.body?.external_message_id?String(req.body.external_message_id):null;
    const error=req.body?.error?String(req.body.error):null;
    const {rows}=await pool.query(
      success
        ? "UPDATE notifications SET status='SENT',external_message_id=$2,sent_at=now(),error=NULL WHERE id=$1 AND channel='DISCORD_READY' AND status='SENDING' RETURNING *"
        : "UPDATE notifications SET status='ERROR',error=$2 WHERE id=$1 AND channel='DISCORD_READY' AND status='SENDING' RETURNING *",
      [req.params.id,success?externalId:error]
    );
    if(!rows[0])return res.status(409).json({error:'Discord notification is not in SENDING state.'});
    if(success && rows[0].special_order_item_id){
      const old=await pool.query('SELECT status FROM special_order_items WHERE id=$1',[rows[0].special_order_item_id]);
      const oldStatus=old.rows[0]?.status;
      if(oldStatus && oldStatus!=='COMPLETED'){
        await pool.query("UPDATE special_order_items SET status='CUSTOMER_NOTIFIED',updated_at=now() WHERE id=$1",[rows[0].special_order_item_id]);
        await pool.query(
          "INSERT INTO order_status_history (special_order_item_id,old_status,new_status,note,changed_by) VALUES ($1,$2,'CUSTOMER_NOTIFIED','Discord ready notification sent','discord-bot')",
          [rows[0].special_order_item_id,oldStatus]
        );
      }
    }
    res.json(rows[0]);
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
