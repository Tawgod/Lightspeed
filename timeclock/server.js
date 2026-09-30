import express from 'express';
import cors from 'cors';
import pg from 'pg';

const { Pool } = pg;
const app = express();
const PORT = process.env.PORT || 8080;
const TIMEZONE = process.env.TIMECLOCK_TIMEZONE || 'America/Chicago';
const DATABASE_URL = process.env.DATABASE_URL;

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
      name TEXT NOT NULL,
      name_key TEXT NOT NULL UNIQUE,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

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

async function resolveEmployee(name) {
  const clean = String(name || '').trim();
  if (!clean) {
    const err = new Error('Employee name is required.');
    err.status = 400;
    throw err;
  }
  const key = clean.toLowerCase().replace(/\s+/g,' ');
  const result = await pool.query(
    `INSERT INTO employees(name, name_key)
     VALUES ($1, $2)
     ON CONFLICT(name_key) DO UPDATE SET name = EXCLUDED.name
     RETURNING *`,
    [clean, key]
  );
  return result.rows[0];
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
    const employee = await resolveEmployee(req.query.employeeName);
    res.json(await employeeStatus(employee));
  } catch (error) {
    res.status(error.status || 500).json({ error:error.message });
  }
});

app.post('/api/timeclock/clock-in', async (req,res) => {
  const client = await pool.connect();
  try {
    const employee = await resolveEmployee(req.body?.employeeName);
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
    const employee = await resolveEmployee(req.body?.employeeName);
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
  .then(() => app.listen(PORT, () => console.log(`Timeclock listening on port ${PORT}`)))
  .catch(error => {
    console.error('Timeclock schema startup failed:', error);
    process.exit(1);
  });
