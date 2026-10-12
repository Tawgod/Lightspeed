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

const name = 'Integration AutoClose Tester 20261012A';
const nameKey = name.toLowerCase();

const employee = await db.query(
  `INSERT INTO employees(name,name_key,active)
   VALUES ($1,$2,TRUE)
   ON CONFLICT (name_key) DO UPDATE SET active=TRUE
   RETURNING id`,
  [name, nameKey]
);

const employeeId = Number(employee.rows[0].id);

const existing = await db.query(
  `SELECT id FROM time_entries
   WHERE employee_id=$1 AND clock_out IS NULL
   ORDER BY clock_in DESC LIMIT 1`,
  [employeeId]
);

let entryId;
if (existing.rows.length) {
  entryId = Number(existing.rows[0].id);
  await db.query(
    `UPDATE time_entries
     SET clock_in=NOW() - INTERVAL '15 hours',
         clock_out=NULL,
         status='OPEN',
         needs_review=FALSE,
         updated_at=NOW()
     WHERE id=$1`,
    [entryId]
  );
} else {
  const entry = await db.query(
    `INSERT INTO time_entries(employee_id,clock_in,status,needs_review)
     VALUES ($1,NOW() - INTERVAL '15 hours','OPEN',FALSE)
     RETURNING id`,
    [employeeId]
  );
  entryId = Number(entry.rows[0].id);
}

console.log('AUTOCLOSE_SEED ' + JSON.stringify({employeeId,entryId}));
await db.end();
