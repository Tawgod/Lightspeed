// Shared local PostgreSQL transaction fence. No authority UPDATE grant needed.
// Every cooperating writer must acquire this same transaction-level advisory lock
// BEFORE reading or changing policy/evidence/session authority. Not a remote fence.
export async function withAuthorityFence(pool, work) {
  const c=await pool.connect(); let committing=false, discard=false;
  try {
    await c.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await c.query("SET LOCAL lock_timeout='3s'");
    await c.query("SET LOCAL statement_timeout='5s'");
    await c.query('SELECT pg_catalog.pg_advisory_xact_lock(1212371795, 25)');
    const result=await work(c);
    committing=true; await c.query('COMMIT'); return result;
  } catch(e) {
    try { await c.query('ROLLBACK'); } catch { discard=true; }
    if(committing) { discard=true; throw Object.assign(new Error('Commit outcome unknown'),{status:503,unknown:true}); }
    throw e;
  } finally { c.release(discard); }
}
