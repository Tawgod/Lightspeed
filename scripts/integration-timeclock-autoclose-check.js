import pg from 'pg';

const { Client } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('Missing DATABASE_URL.');
  process.exit(2);
}

const db = new Client({
  connectionString: databaseUrl,
  ssl: { rejectUnauthorized: false }
});

await db.connect();

const nameKey = 'integration autoclose tester 20261012a';
const result = await db.query(
  `SELECT te.id,te.status,te.clock_in,te.clock_out,te.needs_review,
          EXISTS (
            SELECT 1 FROM clock_events ce
            WHERE ce.employee_id=te.employee_id
              AND ce.event_type='AUTO_CLOCK_OUT'
              AND ce.timestamp_utc=te.clock_out
          ) AS has_auto_event
   FROM time_entries te
   JOIN employees e ON e.id=te.employee_id
   WHERE e.name_key=$1
   ORDER BY te.id DESC
   LIMIT 1`,
  [nameKey]
);

await db.end();

const row = result.rows[0] || null;
const ok = Boolean(
  row &&
  row.status === 'AUTO_CLOSED' &&
  row.clock_out &&
  row.needs_review === true &&
  row.has_auto_event === true
);

console.log('AUTOCLOSE_CHECK ' + JSON.stringify({ok,row}));
process.exit(ok ? 0 : 1);
