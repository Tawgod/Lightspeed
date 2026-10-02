import express from 'express';
import pg from 'pg';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

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

function lightspeedHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'HobbyCorner-SpecialOrders/1.0'
  };
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

export function createSpecialOrdersRouter({ lightspeedDomain, lightspeedToken }) {
  const router = express.Router();

  router.get('/health', async (req, res) => {
    res.json({ ok: true, database: Boolean(pool), lightspeed: Boolean(lightspeedDomain && lightspeedToken) });
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
        INSERT INTO customers (lightspeed_customer_id,name,phone,email,discord_user_id,discord_handle,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,now())
        ON CONFLICT (lightspeed_customer_id) DO UPDATE SET
          name=EXCLUDED.name, phone=COALESCE(EXCLUDED.phone,customers.phone),
          email=COALESCE(EXCLUDED.email,customers.email),
          discord_user_id=COALESCE(EXCLUDED.discord_user_id,customers.discord_user_id),
          discord_handle=COALESCE(EXCLUDED.discord_handle,customers.discord_handle), updated_at=now()
        RETURNING id
      `, [customer.lightspeed_customer_id || null, customer.name, customer.phone || null, customer.email || null,
          customer.discord_user_id || null, customer.discord_handle || null]);

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
             preferred_supplier_id,release_date,ordered_at,notes)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *
        `, [
          orderResult.rows[0].id, item.product_id || null, item.requested_name || item.name,
          item.requested_sku || item.sku || null, item.requested_upc || item.upc || null,
          Number(item.quantity || 1), status, item.preferred_supplier_id || null, item.release_date || null,
          status === 'ORDERED' ? new Date() : null, item.notes || null
        ]);
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
      await client.query('COMMIT');
      res.json(updated.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: error.message });
    } finally {
      client.release();
    }
  });

  router.get('/suppliers', requireDb, async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM suppliers WHERE is_active=true ORDER BY name');
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
    const { supplier_id, product_id, supplier_sku, supply_price, priority = 1, is_orderable = true, notes } = req.body || {};
    if (!supplier_id || !product_id) return res.status(400).json({ error: 'supplier_id and product_id are required.' });
    const { rows } = await pool.query(`
      INSERT INTO supplier_products (supplier_id,product_id,supplier_sku,supply_price,priority,is_orderable,notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (supplier_id,product_id) DO UPDATE SET supplier_sku=EXCLUDED.supplier_sku,
        supply_price=EXCLUDED.supply_price, priority=EXCLUDED.priority, is_orderable=EXCLUDED.is_orderable,
        notes=EXCLUDED.notes
      RETURNING *
    `, [supplier_id, product_id, supplier_sku || null, supply_price || null, priority, Boolean(is_orderable), notes || null]);
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

  router.get('/products/search', async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json([]);

    let local = [];
    if (pool) {
      const localResult = await pool.query(`
        SELECT *, CASE
          WHEN lower(sku)=lower($1) OR upc=$1 THEN 0
          WHEN lower(name)=lower($1) THEN 1
          ELSE 2 END AS rank
        FROM products
        WHERE lower(coalesce(sku,''))=lower($1) OR upc=$1
           OR lower(name) LIKE lower($2) OR lower(coalesce(description,'')) LIKE lower($2)
        ORDER BY rank, name LIMIT 25
      `, [q, `%${q}%`]);
      local = localResult.rows.map(p => ({ ...p, source: 'local' }));
    }

    const seen = new Set(local.map(p => p.lightspeed_product_id).filter(Boolean));
    const remote = [];
    try {
      const [skuResult, nameResult] = await Promise.allSettled([
        lightspeedFetch(lightspeedDomain, lightspeedToken, `/products?sku=${encodeURIComponent(q)}`),
        lightspeedFetch(lightspeedDomain, lightspeedToken, `/products?name=${encodeURIComponent(q)}`)
      ]);
      for (const result of [skuResult, nameResult]) {
        if (result.status !== 'fulfilled') continue;
        for (const product of (result.value?.data || [])) {
          if (!seen.has(product.id)) {
            seen.add(product.id);
            remote.push({ ...product, source: 'lightspeed' });
          }
          await upsertLocalProduct(product);
        }
      }
    } catch (error) {
      if (local.length === 0) return res.status(502).json({ error: error.message });
    }
    res.json([...local, ...remote].slice(0, 25));
  });

  router.post('/products/create-lightspeed', async (req, res) => {
    const body = req.body || {};
    const missing = [];
    if (!body.name) missing.push('name');
    if (!body.sku) missing.push('sku');
    if (body.supply_price === undefined || body.supply_price === null) missing.push('supply_price');
    if (!body.product_category_id && !body.product_type_id) missing.push('product_category_id');
    if (body.price_including_tax === undefined && body.price_excluding_tax === undefined) missing.push('price');
    if (missing.length) return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });

    try {
      const allowed = [
        'name','description','sku','product_codes','is_active','price_including_tax','price_excluding_tax',
        'supply_price','supplier_id','supplier_code','product_suppliers','product_type_id','product_category_id',
        'brand_id','tag_ids','inventory','weight','weight_unit','length','width','height','dimensions_unit'
      ];
      const payload = {};
      for (const key of allowed) if (body[key] !== undefined) payload[key] = body[key];
      const result = await lightspeedFetch(lightspeedDomain, lightspeedToken, '/products', {
        method: 'POST', body: JSON.stringify(payload)
      });
      const product = result?.data || result;
      const localProduct = await upsertLocalProduct(product);
      res.status(201).json({ lightspeed: product, local: localProduct });
    } catch (error) {
      res.status(error.status || 502).json({ error: error.message });
    }
  });

  return router;
}
