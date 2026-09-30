import express from 'express';
import cors from 'cors';
import pg from 'pg';
import crypto from 'crypto';

const { Pool } = pg;
const app = express();
const PORT = process.env.PORT || 8080;
const TIMEZONE = process.env.TIMECLOCK_TIMEZONE || 'America/Chicago';
const DATABASE_URL = process.env.DATABASE_URL;
const PIN_PEPPER = process.env.TIMECLOCK_PIN_PEPPER || '';
const ADMIN_SECRET = process.env.TIMECLOCK_ADMIN_SECRET || '';
const LIGHTSPEED_DOMAIN = process.env.LIGHTSPEED_DOMAIN || '';
const LIGHTSPEED_TOKEN = process.env.LIGHTSPEED_TOKEN || '';

if (!DATABASE_URL) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false }
});

app.use(cors());
app.use(express.json());

const minutesBetween = (start, end) => Math.max(0, Math.round((new Date(end) - new Date(start)) / 60000));

function localParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    year:'numeric', month:'2-digit', day:'2-digit'
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return { year:Number(map.year), month:Number(map.month), day:Number(map.day) };
}

function localDateKey(date = new Date()) {
  const parts = localParts(date);
  return `${parts.year}-${String(parts.month).padStart(2,'0')}-${String(parts.day).padStart(2,'0')}`;
}

function addDays(dateKey, days) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function sundayFor(dateKey) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return addDays(dateKey, -date.getUTCDay());
}

function currentPayPeriod(date = new Date()) {
  const { year, month, day } = localParts(date);
  const startDay = day <= 15 ? 1 : 16;
  const endDay = day <= 15 ? 15 : new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    start: `${year}-${String(month).padStart(2,'0')}-${String(startDay).padStart(2,'0')}`,
    end: `${year}-${String(month).padStart(2,'0')}-${String(endDay).padStart(2,'0')}`
  };
}

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS employees (
      id BIGSERIAL PRIMARY KEY,
      lightspeed_user_id TEXT UNIQUE,
      discord_user_id TEXT UNIQUE,
      discord_username TEXT,
      discord_display_name TEXT,
      pin_hash TEXT UNIQUE,
      name TEXT NOT NULL,
      name_key TEXT NOT NULL UNIQUE,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE employees ADD COLUMN IF NOT EXISTS pin_hash TEXT UNIQUE;
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS discord_username TEXT;
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS discord_display_name TEXT;

    CREATE TABLE IF NOT EXISTS clock_events (
      id BIGSERIAL PRIMARY KEY,
      employee_id BIGINT NOT NULL REFERENCES employees(id),
      event_type TEXT NOT NULL CHECK (event_type IN ('CLOCK_IN','CLOCK_OUT','AUTO_CLOCK_OUT')),
      timestamp_utc TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      location_id TEXT,
      source TEXT NOT NULL DEFAULT 'extension',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS time_entries (
      id BIGSERIAL PRIMARY KEY,
      employee_id BIGINT NOT NULL REFERENCES employees(id),
      clock_in TIMESTAMPTZ NOT NULL,
      clock_out TIMESTAMPTZ,
      break_minutes INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'OPEN',
      original_entry_id BIGINT REFERENCES time_entries(id),
      needs_review BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS one_open_time_entry_per_employee
      ON time_entries(employee_id)
      WHERE clock_out IS NULL;

    CREATE TABLE IF NOT EXISTS time_adjustments (
      id BIGSERIAL PRIMARY KEY,
      time_entry_id BIGINT NOT NULL REFERENCES time_entries(id),
      requested_by TEXT,
      approved_by TEXT,
      old_clock_in TIMESTAMPTZ,
      old_clock_out TIMESTAMPTZ,
      new_clock_in TIMESTAMPTZ,
      new_clock_out TIMESTAMPTZ,
      reason TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id BIGSERIAL PRIMARY KEY,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      object_type TEXT NOT NULL,
      object_id TEXT,
      before_json JSONB,
      after_json JSONB,
      timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS pay_periods (
      id BIGSERIAL PRIMARY KEY,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      locked_at TIMESTAMPTZ,
      locked_by TEXT,
      UNIQUE(start_date, end_date)
    );
  `);
}

function pinHash(pin) {
  if (!PIN_PEPPER) {
    const err = new Error('TIMECLOCK_PIN_PEPPER is not configured.');
    err.status = 500;
    throw err;
  }
  return crypto.createHmac('sha256', PIN_PEPPER).update(String(pin)).digest('hex');
}

async function resolveEmployee(identifier) {
  const clean = String(identifier || '').trim();
  if (!clean) {
    const err = new Error('Employee name or PIN is required.');
    err.status = 400;
    throw err;
  }

  if (/^\d{4}$/.test(clean)) {
    const result = await pool.query(
      'SELECT * FROM employees WHERE pin_hash=$1 AND active=TRUE LIMIT 1',
      [pinHash(clean)]
    );
    if (!result.rows.length) {
      const err = new Error('Invalid employee PIN.');
      err.status = 404;
      throw err;
    }
    return result.rows[0];
  }

  const key = clean.toLowerCase().replace(/\s+/g,' ');
  const result = await pool.query(
    'SELECT * FROM employees WHERE name_key=$1 AND active=TRUE LIMIT 1',
    [key]
  );
  if (!result.rows.length) {
    const err = new Error('Employee not found. Ask a timeclock admin to link this user before clocking in.');
    err.status = 404;
    throw err;
  }
  return result.rows[0];
}

async function assignEmployeePin({ discordUserId, pin }) {
  const cleanDiscordId = String(discordUserId || '').trim();
  const cleanPin = String(pin || '').trim();

  if (!cleanDiscordId) {
    const err = new Error('discordUserId is required.');
    err.status = 400;
    throw err;
  }
  if (!/^\d{4}$/.test(cleanPin)) {
    const err = new Error('PIN must be exactly 4 digits.');
    err.status = 400;
    throw err;
  }
  if (!/^\d{4}$/.test(cleanPin)) {
    const err = new Error('PIN must be exactly 4 digits.');
    err.status = 400;
    throw err;
  }

  const hash = pinHash(cleanPin);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const employeeResult = await client.query(
      'SELECT * FROM employees WHERE discord_user_id=$1 AND active=TRUE LIMIT 1 FOR UPDATE',
      [cleanDiscordId]
    );

    if (!employeeResult.rows.length) {
      const err = new Error('Discord user is not linked to an employee. Use /hc timeclock employees and /hc timeclock link first.');
      err.status = 404;
      throw err;
    }

    const employee = employeeResult.rows[0];
    const duplicate = await client.query(
      'SELECT id FROM employees WHERE pin_hash=$1 AND id<>$2 LIMIT 1',
      [hash, employee.id]
    );

    if (duplicate.rows.length) {
      const err = new Error('That PIN is already assigned to another employee.');
      err.status = 409;
      throw err;
    }

    const updated = await client.query(
      `UPDATE employees
       SET pin_hash=$2, active=TRUE
       WHERE id=$1
       RETURNING *`,
      [employee.id, hash]
    );

    const row = updated.rows[0];
    await client.query(
      `INSERT INTO audit_log(actor, action, object_type, object_id, after_json)
       VALUES ('DISCORD_ADMIN', 'ASSIGN_PIN', 'employee', $1, $2::jsonb)`,
      [
        String(row.id),
        JSON.stringify({
          employeeId: row.id,
          employeeName: row.name,
          discordUserId: row.discord_user_id,
          pinAssigned: true
        })
      ]
    );

    await client.query('COMMIT');
    return {
      employeeId: row.id,
      employeeName: row.name,
      discordUserId: row.discord_user_id,
      pinAssigned: true
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function listEmployees() {
  const result = await pool.query(
    `SELECT
       id,
       name,
       lightspeed_user_id,
       discord_user_id,
       discord_username,
       discord_display_name,
       active,
       (pin_hash IS NOT NULL) AS has_pin,
       created_at
     FROM employees
     ORDER BY active DESC, name ASC`
  );

  return result.rows;
}

async function linkEmployeeDiscord({
  employeeId,
  discordUserId,
  discordUsername,
  discordDisplayName,
  pin,
  actor
}) {
  const id = Number(employeeId);
  const cleanDiscordId = String(discordUserId || '').trim();
  const username = String(discordUsername || '').trim();
  const displayName = String(discordDisplayName || '').trim();
  const cleanPin = String(pin || '').trim();
  const cleanActor = String(actor || 'DISCORD_ADMIN').trim() || 'DISCORD_ADMIN';

  if (!Number.isInteger(id) || id <= 0) {
    const err = new Error('Valid employeeId is required.');
    err.status = 400;
    throw err;
  }
  if (!cleanDiscordId) {
    const err = new Error('discordUserId is required.');
    err.status = 400;
    throw err;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query(
      'SELECT * FROM employees WHERE id=$1 LIMIT 1 FOR UPDATE',
      [id]
    );
    if (!existing.rows.length) {
      const err = new Error('Employee not found.');
      err.status = 404;
      throw err;
    }

    const duplicate = await client.query(
      'SELECT id, name FROM employees WHERE discord_user_id=$1 AND id<>$2 LIMIT 1',
      [cleanDiscordId, id]
    );
    if (duplicate.rows.length) {
      const err = new Error(`That Discord account is already linked to employee #${duplicate.rows[0].id} (${duplicate.rows[0].name}).`);
      err.status = 409;
      throw err;
    }

    const hash = pinHash(cleanPin);
    const duplicatePin = await client.query(
      'SELECT id, name FROM employees WHERE pin_hash=$1 AND id<>$2 LIMIT 1',
      [hash, id]
    );
    if (duplicatePin.rows.length) {
      const err = new Error(`That PIN is already assigned to employee #${duplicatePin.rows[0].id} (${duplicatePin.rows[0].name}).`);
      err.status = 409;
      throw err;
    }

    const before = existing.rows[0];
    const updated = await client.query(
      `UPDATE employees
       SET discord_user_id=$2,
           discord_username=NULLIF($3,''),
           discord_display_name=NULLIF($4,''),
           pin_hash=$5,
           active=TRUE
       WHERE id=$1
       RETURNING *`,
      [id, cleanDiscordId, username, displayName, hash]
    );

    await client.query(
      `INSERT INTO audit_log(actor, action, object_type, object_id, before_json, after_json)
       VALUES ($1, 'LINK_DISCORD_EMPLOYEE', 'employee', $2, $3::jsonb, $4::jsonb)`,
      [
        cleanActor,
        String(id),
        JSON.stringify(before),
        JSON.stringify(updated.rows[0])
      ]
    );

    await client.query('COMMIT');
    return updated.rows[0];
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function lightspeedUserName(user) {
  const direct = [
    user?.display_name,
    user?.displayName,
    user?.name,
    user?.username
  ].find(value => String(value || '').trim());

  if (direct) return String(direct).trim();

  const first = String(user?.first_name || user?.firstName || '').trim();
  const last = String(user?.last_name || user?.lastName || '').trim();
  const combined = [first, last].filter(Boolean).join(' ').trim();
  if (combined) return combined;

  const email = String(user?.email || '').trim();
  return email || '';
}

async function fetchLightspeedUsers() {
  if (!LIGHTSPEED_DOMAIN || !LIGHTSPEED_TOKEN) {
    const err = new Error('Lightspeed user sync is not configured.');
    err.status = 500;
    throw err;
  }

  const response = await fetch(
    `https://${LIGHTSPEED_DOMAIN}.retail.lightspeed.app/api/2.0/users?page_size=1000`,
    {
      headers:{
        Authorization:`Bearer ${LIGHTSPEED_TOKEN}`,
        Accept:'application/json',
        'User-Agent':'HobbyCorner-Timeclock/1.0'
      }
    }
  );

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    const err = new Error(`Lightspeed user sync failed (${response.status}).`);
    err.status = response.status;
    err.details = data;
    throw err;
  }

  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.users)) return data.users;
  return [];
}

async function syncLightspeedUsers() {
  const users = await fetchLightspeedUsers();
  const client = await pool.connect();

  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  try {
    await client.query('BEGIN');

    for (const user of users) {
      const lightspeedId = String(user?.id || user?.user_id || user?.userId || '').trim();
      const name = lightspeedUserName(user);
      if (!lightspeedId || !name) {
        skipped++;
        continue;
      }

      const key = name.toLowerCase().replace(/\s+/g, ' ');

      let existing = await client.query(
        'SELECT * FROM employees WHERE lightspeed_user_id=$1 LIMIT 1 FOR UPDATE',
        [lightspeedId]
      );

      if (!existing.rows.length) {
        existing = await client.query(
          'SELECT * FROM employees WHERE name_key=$1 LIMIT 1 FOR UPDATE',
          [key]
        );
      }

      if (existing.rows.length) {
        const row = existing.rows[0];
        await client.query(
          `UPDATE employees
           SET lightspeed_user_id=$2,
               name=$3,
               name_key=$4,
               active=TRUE
           WHERE id=$1`,
          [row.id, lightspeedId, name, key]
        );
        updated++;
      } else {
        await client.query(
          `INSERT INTO employees(lightspeed_user_id, name, name_key, active)
           VALUES ($1,$2,$3,TRUE)`,
          [lightspeedId, name, key]
        );
        inserted++;
      }
    }

    await client.query('COMMIT');
    return { total:users.length, inserted, updated, skipped };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function employeeStatus(employee) {
  const openResult = await pool.query(
    `SELECT * FROM time_entries
     WHERE employee_id=$1 AND clock_out IS NULL
     ORDER BY clock_in DESC LIMIT 1`,
    [employee.id]
  );
  const open = openResult.rows[0] || null;

  const todayResult = await pool.query(
    `SELECT clock_in, clock_out, break_minutes
     FROM time_entries
     WHERE employee_id=$1
       AND (clock_in AT TIME ZONE $2)::date = (NOW() AT TIME ZONE $2)::date
     ORDER BY clock_in`,
    [employee.id, TIMEZONE]
  );

  let todayMinutes = 0;
  for (const row of todayResult.rows) {
    const end = row.clock_out || new Date();
    todayMinutes += Math.max(0, minutesBetween(row.clock_in, end) - Number(row.break_minutes || 0));
  }

  const period = currentPayPeriod();
  const periodResult = await pool.query(
    `SELECT clock_in, clock_out, break_minutes
     FROM time_entries
     WHERE employee_id=$1
       AND (clock_in AT TIME ZONE $2)::date BETWEEN $3::date AND $4::date
     ORDER BY clock_in`,
    [employee.id, TIMEZONE, period.start, period.end]
  );

  let payPeriodMinutes = 0;
  for (const row of periodResult.rows) {
    const end = row.clock_out || new Date();
    payPeriodMinutes += Math.max(0, minutesBetween(row.clock_in, end) - Number(row.break_minutes || 0));
  }

  const historyResult = await pool.query(
    `SELECT id, clock_in, clock_out, break_minutes, status, needs_review
     FROM time_entries
     WHERE employee_id=$1
       AND (clock_in AT TIME ZONE $2)::date >= ((NOW() AT TIME ZONE $2)::date - INTERVAL '35 days')
     ORDER BY clock_in`,
    [employee.id, TIMEZONE]
  );

  const minutesByDay = new Map();
  const entriesByDay = new Map();
  for (const row of historyResult.rows) {
    const dayKey = localDateKey(new Date(row.clock_in));
    const end = row.clock_out || new Date();
    const minutes = Math.max(0, minutesBetween(row.clock_in, end) - Number(row.break_minutes || 0));
    minutesByDay.set(dayKey, (minutesByDay.get(dayKey) || 0) + minutes);
    entriesByDay.set(dayKey, (entriesByDay.get(dayKey) || 0) + 1);
  }

  const todayKey = localDateKey();
  const recentDays = Array.from({ length: 7 }, (_, index) => {
    const date = addDays(todayKey, -index);
    return {
      date,
      minutes: minutesByDay.get(date) || 0,
      entryCount: entriesByDay.get(date) || 0
    };
  });

  const thisSunday = sundayFor(todayKey);
  const weeklySummaries = Array.from({ length: 4 }, (_, index) => {
    const start = addDays(thisSunday, -(index * 7));
    const end = addDays(start, 6);
    let minutes = 0;
    for (let offset = 0; offset < 7; offset++) {
      minutes += minutesByDay.get(addDays(start, offset)) || 0;
    }
    return {
      start,
      end,
      minutes,
      current: index === 0
    };
  });

  return {
    employee:{ id:employee.id, name:employee.name },
    clockedIn:Boolean(open),
    clockIn:open?.clock_in || null,
    currentEntryId:open?.id || null,
    todayMinutes,
    payPeriodMinutes,
    payPeriod:period,
    recentDays,
    weeklySummaries,
    timezone:TIMEZONE
  };
}

async function autoCloseOverlongShifts() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const overdue = await client.query(
      `SELECT te.*, e.name AS employee_name
       FROM time_entries te
       JOIN employees e ON e.id = te.employee_id
       WHERE te.clock_out IS NULL
         AND te.clock_in <= NOW() - INTERVAL '14 hours'
       ORDER BY te.clock_in
       FOR UPDATE OF te`
    );

    for (const entry of overdue.rows) {
      const autoClockOutAt = new Date(new Date(entry.clock_in).getTime() + (14 * 60 * 60 * 1000));

      const updated = await client.query(
        `UPDATE time_entries
         SET clock_out=$2,
             status='AUTO_CLOSED',
             needs_review=TRUE,
             updated_at=NOW()
         WHERE id=$1
         RETURNING *`,
        [entry.id, autoClockOutAt]
      );

      await client.query(
        `INSERT INTO clock_events(employee_id, event_type, timestamp_utc, source)
         VALUES ($1, 'AUTO_CLOCK_OUT', $2, 'server-auto-close')`,
        [entry.employee_id, autoClockOutAt]
      );

      await client.query(
        `INSERT INTO audit_log(actor, action, object_type, object_id, before_json, after_json)
         VALUES ('SYSTEM', 'AUTO_CLOCK_OUT_14H', 'time_entry', $1, $2::jsonb, $3::jsonb)`,
        [String(entry.id), JSON.stringify(entry), JSON.stringify(updated.rows[0])]
      );
    }

    await client.query('COMMIT');

    if (overdue.rows.length) {
      console.log(`Auto-closed ${overdue.rows.length} time entr${overdue.rows.length === 1 ? 'y' : 'ies'} at the 14-hour limit.`);
    }

    return overdue.rows.length;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('14-hour auto clock-out sweep failed:', error);
    throw error;
  } finally {
    client.release();
  }
}

app.get('/health', async (req,res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok:true, service:'hobby-corner-timeclock', timezone:TIMEZONE });
  } catch (error) {
    res.status(500).json({ ok:false, error:error.message });
  }
});

app.get('/api/timeclock/status', async (req,res) => {
  try {
    const employee = await resolveEmployee(req.query.identifier || req.query.employeeName);
    res.json(await employeeStatus(employee));
  } catch (error) {
    res.status(error.status || 500).json({ error:error.message });
  }
});

app.get('/api/timeclock/admin/employees', async (req,res) => {
  try {
    if (!ADMIN_SECRET || req.get('x-timeclock-admin-secret') !== ADMIN_SECRET) {
      return res.status(403).json({ error:'Forbidden.' });
    }

    let sync = null;
    let syncWarning = null;
    try {
      sync = await syncLightspeedUsers();
    } catch (error) {
      syncWarning = error.message;
      console.error('Lightspeed employee sync failed:', error.message, error.details || '');
    }

    const employees = await listEmployees();
    res.json({
      count:employees.length,
      employees,
      lightspeedSync:sync,
      syncWarning
    });
  } catch (error) {
    res.status(500).json({ error:error.message });
  }
});

app.post('/api/timeclock/admin/link-discord', async (req,res) => {
  try {
    if (!ADMIN_SECRET || req.get('x-timeclock-admin-secret') !== ADMIN_SECRET) {
      return res.status(403).json({ error:'Forbidden.' });
    }

    const employee = await linkEmployeeDiscord({
      employeeId:req.body?.employeeId,
      discordUserId:req.body?.discordUserId,
      discordUsername:req.body?.discordUsername,
      discordDisplayName:req.body?.discordDisplayName,
      pin:req.body?.pin,
      actor:req.body?.actor
    });

    res.json({
      linked:true,
      employee:{
        id:employee.id,
        name:employee.name,
        lightspeedUserId:employee.lightspeed_user_id,
        discordUserId:employee.discord_user_id,
        discordUsername:employee.discord_username,
        discordDisplayName:employee.discord_display_name
      }
    });
  } catch (error) {
    res.status(error.status || 500).json({ error:error.message });
  }
});

app.post('/api/timeclock/admin/assign-pin', async (req,res) => {
  try {
    if (!ADMIN_SECRET || req.get('x-timeclock-admin-secret') !== ADMIN_SECRET) {
      return res.status(403).json({ error:'Forbidden.' });
    }

    const result = await assignEmployeePin({
      discordUserId: req.body?.discordUserId,
      pin: req.body?.pin
    });

    res.json(result);
  } catch (error) {
    res.status(error.status || 500).json({ error:error.message });
  }
});

app.get('/api/timeclock/admin/review', async (req,res) => {
  try {
    if (!ADMIN_SECRET || req.get('x-timeclock-admin-secret') !== ADMIN_SECRET) {
      return res.status(403).json({ error:'Forbidden.' });
    }

    const result = await pool.query(
      `SELECT te.id, te.clock_in, te.clock_out, te.status, te.needs_review,
              e.name AS employee_name, e.discord_user_id
       FROM time_entries te
       JOIN employees e ON e.id = te.employee_id
       WHERE te.needs_review = TRUE
       ORDER BY te.clock_in DESC
       LIMIT 100`
    );

    res.json({ count:result.rows.length, entries:result.rows });
  } catch (error) {
    res.status(500).json({ error:error.message });
  }
});

app.post('/api/timeclock/admin/entries/:entryId/adjust', async (req,res) => {
  const client = await pool.connect();
  try {
    if (!ADMIN_SECRET || req.get('x-timeclock-admin-secret') !== ADMIN_SECRET) {
      return res.status(403).json({ error:'Forbidden.' });
    }

    const entryId = Number(req.params.entryId);
    const reason = String(req.body?.reason || '').trim();
    const actor = String(req.body?.actor || 'DISCORD_MANAGER').trim() || 'DISCORD_MANAGER';
    const clockIn = req.body?.clockIn ? new Date(req.body.clockIn) : null;
    const clockOut = req.body?.clockOut ? new Date(req.body.clockOut) : null;

    if (!Number.isInteger(entryId) || entryId <= 0) return res.status(400).json({ error:'Valid entryId is required.' });
    if (!reason) return res.status(400).json({ error:'A correction reason is required.' });
    if (!clockIn || Number.isNaN(clockIn.getTime())) return res.status(400).json({ error:'Valid clockIn is required.' });
    if (!clockOut || Number.isNaN(clockOut.getTime())) return res.status(400).json({ error:'Valid clockOut is required.' });
    if (clockOut <= clockIn) return res.status(400).json({ error:'clockOut must be after clockIn.' });

    await client.query('BEGIN');

    const existing = await client.query(
      `SELECT te.*, e.name AS employee_name
       FROM time_entries te
       JOIN employees e ON e.id = te.employee_id
       WHERE te.id=$1
       FOR UPDATE`,
      [entryId]
    );

    if (!existing.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error:'Time entry not found.' });
    }

    const before = existing.rows[0];

    const overlap = await client.query(
      `SELECT id FROM time_entries
       WHERE employee_id=$1
         AND id<>$2
         AND clock_in < $4
         AND COALESCE(clock_out, NOW()) > $3
       LIMIT 1`,
      [before.employee_id, entryId, clockIn, clockOut]
    );

    if (overlap.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error:'Correction would overlap another time entry for this employee.',
        overlappingEntryId:overlap.rows[0].id
      });
    }

    const updated = await client.query(
      `UPDATE time_entries
       SET clock_in=$2,
           clock_out=$3,
           status='CLOSED',
           needs_review=FALSE,
           updated_at=NOW()
       WHERE id=$1
       RETURNING *`,
      [entryId, clockIn, clockOut]
    );

    await client.query(
      `INSERT INTO time_adjustments(
         time_entry_id, requested_by, approved_by,
         old_clock_in, old_clock_out, new_clock_in, new_clock_out, reason
       )
       VALUES ($1,$2,$2,$3,$4,$5,$6,$7)`,
      [entryId, actor, before.clock_in, before.clock_out, clockIn, clockOut, reason]
    );

    await client.query(
      `INSERT INTO audit_log(actor, action, object_type, object_id, before_json, after_json)
       VALUES ($1, 'TIME_ENTRY_CORRECTION', 'time_entry', $2, $3::jsonb, $4::jsonb)`,
      [
        actor,
        String(entryId),
        JSON.stringify(before),
        JSON.stringify({ ...updated.rows[0], reason })
      ]
    );

    await client.query('COMMIT');
    res.json({
      corrected:true,
      entry:{ ...updated.rows[0], employeeName:before.employee_name },
      reason
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(error.status || 500).json({ error:error.message });
  } finally {
    client.release();
  }
});

app.post('/api/timeclock/clock-in', async (req,res) => {
  const client = await pool.connect();
  try {
    const employee = await resolveEmployee(req.body?.identifier || req.body?.employeeName);
    await client.query('BEGIN');

    const existing = await client.query(
      'SELECT id FROM time_entries WHERE employee_id=$1 AND clock_out IS NULL LIMIT 1',
      [employee.id]
    );
    if (existing.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error:'Employee is already clocked in.' });
    }

    const entry = await client.query(
      `INSERT INTO time_entries(employee_id, clock_in, status)
       VALUES ($1, NOW(), 'OPEN')
       RETURNING *`,
      [employee.id]
    );

    await client.query(
      `INSERT INTO clock_events(employee_id, event_type, source)
       VALUES ($1, 'CLOCK_IN', 'extension')`,
      [employee.id]
    );

    await client.query(
      `INSERT INTO audit_log(actor, action, object_type, object_id, after_json)
       VALUES ($1, 'CLOCK_IN', 'time_entry', $2, $3::jsonb)`,
      [employee.name, String(entry.rows[0].id), JSON.stringify(entry.rows[0])]
    );

    await client.query('COMMIT');
    res.status(201).json(await employeeStatus(employee));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(error.status || 500).json({ error:error.message });
  } finally {
    client.release();
  }
});

app.post('/api/timeclock/clock-out', async (req,res) => {
  const client = await pool.connect();
  try {
    const employee = await resolveEmployee(req.body?.identifier || req.body?.employeeName);
    await client.query('BEGIN');

    const open = await client.query(
      `SELECT * FROM time_entries
       WHERE employee_id=$1 AND clock_out IS NULL
       ORDER BY clock_in DESC LIMIT 1
       FOR UPDATE`,
      [employee.id]
    );
    if (!open.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error:'Employee is not currently clocked in.' });
    }

    const entry = open.rows[0];
    const updated = await client.query(
      `UPDATE time_entries
       SET clock_out=NOW(), status='CLOSED', updated_at=NOW()
       WHERE id=$1
       RETURNING *`,
      [entry.id]
    );

    await client.query(
      `INSERT INTO clock_events(employee_id, event_type, source)
       VALUES ($1, 'CLOCK_OUT', 'extension')`,
      [employee.id]
    );

    await client.query(
      `INSERT INTO audit_log(actor, action, object_type, object_id, before_json, after_json)
       VALUES ($1, 'CLOCK_OUT', 'time_entry', $2, $3::jsonb, $4::jsonb)`,
      [employee.name, String(entry.id), JSON.stringify(entry), JSON.stringify(updated.rows[0])]
    );

    await client.query('COMMIT');
    res.json(await employeeStatus(employee));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(error.status || 500).json({ error:error.message });
  } finally {
    client.release();
  }
});

ensureSchema()
  .then(async () => {
    await autoCloseOverlongShifts();
    setInterval(() => {
      autoCloseOverlongShifts().catch(() => {});
    }, 5 * 60 * 1000);

    app.listen(PORT, () => console.log(`Timeclock listening on port ${PORT}`));
  })
  .catch(error => {
    console.error('Timeclock schema startup failed:', error);
    process.exit(1);
  });
