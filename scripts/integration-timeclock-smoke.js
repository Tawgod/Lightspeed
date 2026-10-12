import pg from 'pg';

const { Client } = pg;

const base = process.env.TIMECLOCK_TARGET_BASE;
const adminSecret = process.env.TIMECLOCK_TEST_ADMIN_SECRET;
const databaseUrl = process.env.DATABASE_URL;

if (!base || !adminSecret || !databaseUrl) {
  console.error('Missing TIMECLOCK_TARGET_BASE, TIMECLOCK_TEST_ADMIN_SECRET, or DATABASE_URL.');
  process.exit(2);
}

const testName = 'Integration Tester 20261012A';
const nameKey = testName.toLowerCase();

const db = new Client({
  connectionString: databaseUrl,
  ssl: { rejectUnauthorized: false }
});

await db.connect();
const seeded = await db.query(
  `INSERT INTO employees(name,name_key,active)
   VALUES ($1,$2,TRUE)
   ON CONFLICT (name_key) DO UPDATE SET active=TRUE
   RETURNING id`,
  [testName, nameKey]
);
const employeeId = Number(seeded.rows[0].id);
await db.end();

const checks = [
  { name:'health', method:'GET', path:'/health', expected:[200] },
  { name:'status-before', method:'GET', path:'/api/timeclock/status?identifier=' + encodeURIComponent(testName), expected:[200] },
  { name:'clock-in', method:'POST', path:'/api/timeclock/clock-in', expected:[201], json:{employeeName:testName} },
  { name:'duplicate-clock-in', method:'POST', path:'/api/timeclock/clock-in', expected:[409], json:{employeeName:testName} },
  { name:'clock-out', method:'POST', path:'/api/timeclock/clock-out', expected:[200], json:{employeeName:testName} },
  { name:'duplicate-clock-out', method:'POST', path:'/api/timeclock/clock-out', expected:[409], json:{employeeName:testName} },
  { name:'admin-review', method:'GET', path:'/api/timeclock/admin/review', expected:[200], admin:true },
  {
    name:'manual-entry',
    method:'POST',
    path:'/api/timeclock/admin/entries',
    expected:[201],
    admin:true,
    json:{
      employeeId,
      clockIn:'2026-10-11T14:00:00Z',
      clockOut:'2026-10-11T22:00:00Z',
      reason:'integration smoke test',
      actor:'INTEGRATION_TEST'
    }
  }
];

let passed = 0;
const failures = [];

for (const check of checks) {
  try {
    const headers = {};
    if (check.admin) headers['x-timeclock-admin-secret'] = adminSecret;
    if (check.json !== undefined) headers['content-type'] = 'application/json';

    const response = await fetch(base + check.path, {
      method: check.method,
      headers,
      body: check.json !== undefined ? JSON.stringify(check.json) : undefined
    });
    const body = await response.text();
    const ok = check.expected.includes(response.status);

    console.log(JSON.stringify({
      name:check.name,
      ok,
      status:response.status,
      expected:check.expected,
      body:body.slice(0,220)
    }));

    if (ok) passed += 1;
    else failures.push({name:check.name,status:response.status,expected:check.expected});
  } catch (error) {
    failures.push({name:check.name,error:error.message});
    console.error(JSON.stringify({name:check.name,ok:false,error:error.message}));
  }
}

console.log('TIMECLOCK_SMOKE_SUMMARY ' + JSON.stringify({
  passed,
  total:checks.length,
  failures,
  employeeId
}));

process.exit(failures.length ? 1 : 0);
