import XLSX from 'xlsx';
import crypto from 'crypto';

function clean(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function excelDate(v) {
  if (!v) return null;
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v;
  if (typeof v === 'number') {
    const d = XLSX.SSF.parse_date_code(v);
    if (d) return new Date(Date.UTC(d.y, d.m - 1, d.d, d.H || 0, d.M || 0, d.S || 0));
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function normalizePhone(v) {
  const s = clean(v);
  if (!s) return null;
  const digits = s.replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : s;
}

function mapStatus(status, notes, source) {
  const s = `${status || ''} ${notes || ''}`.toLowerCase();
  if (s.includes('cancel')) return 'CANCELLED';
  if (s.includes('pick') || s.includes('complete')) return 'COMPLETED';
  if (s.includes('received') || s.includes('arrived')) return 'RECEIVED';
  if (s.includes('backorder')) return 'BACKORDERED';
  if (s.includes('ordered')) return 'ORDERED';
  if (s.includes('preorder') || source === 'tcg_preorder') return 'PREORDER';
  if (s.includes('oos') || s.includes('out of stock')) return 'OOS';
  return source === 'gw_recurring' ? 'READY_TO_ORDER' : 'OOS';
}

function rowsFromSheet(workbook, name) {
  const sheet = workbook.Sheets[name];
  return sheet ? XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null }) : [];
}

async function findOrCreateCustomer(client, { name, phone, email, discordHandle }) {
  const n = clean(name) || 'Unknown customer';
  const p = normalizePhone(phone);
  const e = clean(email);
  let found = null;
  if (p) {
    const r = await client.query('SELECT * FROM customers WHERE regexp_replace(coalesce(phone,\'\'), \'\\D\', \'\', \'g\') LIKE $1 LIMIT 1', [`%${p}`]);
    found = r.rows[0];
  }
  if (!found && e) {
    const r = await client.query('SELECT * FROM customers WHERE lower(email)=lower($1) LIMIT 1', [e]);
    found = r.rows[0];
  }
  if (!found) {
    const r = await client.query('SELECT * FROM customers WHERE lower(name)=lower($1) LIMIT 1', [n]);
    found = r.rows[0];
  }
  if (found) {
    const r = await client.query(
      `UPDATE customers SET
         phone=COALESCE(phone,$2), email=COALESCE(email,$3),
         discord_handle=COALESCE(discord_handle,$4), updated_at=now()
       WHERE id=$1 RETURNING *`,
      [found.id, clean(phone), e, clean(discordHandle)]
    );
    return r.rows[0];
  }
  const r = await client.query(
    'INSERT INTO customers (name,phone,email,discord_handle) VALUES ($1,$2,$3,$4) RETURNING *',
    [n, clean(phone), e, clean(discordHandle)]
  );
  return r.rows[0];
}

async function findSupplier(client, rawName) {
  const name = clean(rawName);
  if (!name) return null;
  const exact = await client.query('SELECT * FROM suppliers WHERE lower(name)=lower($1) LIMIT 1', [name]);
  if (exact.rows[0]) return exact.rows[0];
  const aliases = {
    hh: 'Horizon Hobby, Inc.',
    horizon: 'Horizon Hobby, Inc.',
    stevens: 'Stevens International',
    acd: 'ACD Distribution',
    bandai: 'Bluefin'
  };
  const alias = aliases[name.toLowerCase()];
  if (!alias) return null;
  const r = await client.query('SELECT * FROM suppliers WHERE name=$1 LIMIT 1', [alias]);
  return r.rows[0] || null;
}

async function insertItem(client, data) {
  const importKey = data.importKey;
  const existing = await client.query('SELECT id FROM special_order_items WHERE import_key=$1', [importKey]);
  if (existing.rows[0]) return { skipped: true };

  const customer = await findOrCreateCustomer(client, data.customer);
  const supplier = await findSupplier(client, data.supplier);
  const order = await client.query(
    'INSERT INTO special_orders (customer_id,source,legacy_source,notes,created_by,created_at) VALUES ($1,$2,$3,$4,$5,COALESCE($6,now())) RETURNING *',
    [customer.id, data.source, data.legacySource, data.orderNotes || null, 'workbook-import', data.createdAt]
  );
  const status = mapStatus(data.status, data.notes, data.source);
  const orderedAt = status === 'ORDERED' ? (data.statusDate || data.createdAt || new Date()) : null;
  const item = await client.query(
    `INSERT INTO special_order_items
      (special_order_id,requested_name,requested_sku,quantity,status,preferred_supplier_id,release_date,
       ordered_at,notes,legacy_status,import_key,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,COALESCE($12,now())) RETURNING *`,
    [order.rows[0].id, data.itemName || 'Unknown item', data.sku || null, Math.max(1, Number(data.qty || 1)),
     status, supplier?.id || null, data.releaseDate || null, orderedAt, data.notes || null,
     clean(data.status), importKey, data.createdAt]
  );
  await client.query(
    'INSERT INTO order_status_history (special_order_item_id,new_status,note,changed_by,changed_at) VALUES ($1,$2,$3,$4,COALESCE($5,now()))',
    [item.rows[0].id, status, 'Imported from legacy workbook', 'workbook-import', data.statusDate || data.createdAt]
  );
  return { skipped: false };
}

export async function importLegacyWorkbook(pool, buffer, fileName='HC Special orders.xlsx') {
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  const prior = await pool.query('SELECT * FROM special_order_import_runs WHERE source_hash=$1', [hash]);
  if (prior.rows[0]) return { alreadyImported: true, run: prior.rows[0] };

  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const client = await pool.connect();
  let imported = 0, skipped = 0;
  const bySource = {};

  try {
    await client.query('BEGIN');

    // Build Discord lookup before order rows.
    const discord = new Map();
    for (const row of rowsFromSheet(workbook, 'Discord').slice(1)) {
      const [name, phone, handle, email] = row;
      if (!clean(name)) continue;
      discord.set(clean(name).toLowerCase(), { phone: clean(phone), handle: clean(handle), email: clean(email) });
    }

    const push = async (data) => {
      const d = discord.get((clean(data.customer.name) || '').toLowerCase());
      if (d) {
        data.customer.phone = data.customer.phone || d.phone;
        data.customer.email = data.customer.email || d.email;
        data.customer.discordHandle = data.customer.discordHandle || d.handle;
      }
      const r = await insertItem(client, data);
      if (r.skipped) skipped++; else imported++;
      bySource[data.source] = (bySource[data.source] || 0) + (r.skipped ? 0 : 1);
    };

    // Iowa City main tracker: header is row 2.
    const ic = rowsFromSheet(workbook, 'Iowa City');
    for (let i=2; i<ic.length; i++) {
      const r = ic[i];
      const [date,name,phone,textFlag,supplier,itemName,item1,item2,qty,statusDate,status,notes,paid,wo] = r;
      if (!clean(name) || !clean(itemName)) continue;
      await push({
        source:'legacy_special_order', legacySource:`Iowa City row ${i+1}`,
        importKey:`iowa-city:${i+1}`,
        createdAt:excelDate(date), statusDate:excelDate(statusDate),
        customer:{name,phone},
        supplier, itemName, sku:clean(item1)||clean(item2), qty, status, notes,
        orderNotes:[textFlag ? `Text?: ${textFlag}` : null, paid ? `Paid: ${paid}` : null, wo ? `WO #: ${wo}` : null].filter(Boolean).join(' | ') || null
      });
    }

    // GW sheet contains recurring White Dwarf rows followed by normal special orders.
    const gw = rowsFromSheet(workbook, 'GW Orders');
    for (let i=2; i<gw.length; i++) {
      const r = gw[i];
      const [date,name,phone,discordHandle,itemName,qty,statusDate,status,web,notes,paid,,gwPos,invoice] = r;
      if (!clean(name) || !clean(itemName) || String(date || '').toLowerCase() === 'date') continue;
      const recurring = /white dwarf pulled every month/i.test(String(itemName || ''));
      await push({
        source:recurring ? 'gw_recurring' : 'gw_special_order',
        legacySource:`GW Orders row ${i+1}`, importKey:`gw:${i+1}`,
        createdAt:excelDate(date), statusDate:excelDate(statusDate),
        customer:{name,phone,discordHandle}, supplier:'Games Workshop',
        itemName, qty, status, notes,
        orderNotes:[web ? `Web: ${web}` : null, paid ? `Paid: ${paid}` : null, gwPos ? `GW POS #: ${gwPos}` : null, invoice ? `Invoice #: ${invoice}` : null].filter(Boolean).join(' | ') || null
      });
    }

    // The old TCG Preorders tab is retained only as legacy reference.
    // Active Pokemon/TCG preorders now live in the separate HC Preorders system and are not imported here.
    const legacyTcgRows = rowsFromSheet(workbook, 'TCG Preorders').slice(1)
      .filter(r => clean(r[1]) && clean(r[6])).length;
    bySource.legacy_tcg_reference_ignored = legacyTcgRows;

    const run = await client.query(
      'INSERT INTO special_order_import_runs (file_name,source_hash,imported_rows,skipped_rows,details) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [fileName, hash, imported, skipped, JSON.stringify({bySource})]
    );
    await client.query('COMMIT');
    return { alreadyImported:false, run:run.rows[0], imported, skipped, bySource };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
