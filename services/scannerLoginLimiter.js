import crypto from 'node:crypto';

// Shared PostgreSQL-based limiter, effective across all Railway replicas.
// Requests are reserved BEFORE PIN verification, including unsuccessful ones.
// Keeps no raw PIN or client IP in the database.
export async function createScannerLoginLimiter({pool,secret}={}){
 if(!pool || typeof pool.query!=='function' || typeof secret!=='string' || secret.length<32)throw new Error('Scanner database login limiter is not configured.');
 await pool.query(`CREATE TABLE IF NOT EXISTS scanner_login_limits (
   key_hash TEXT PRIMARY KEY, window_started TIMESTAMPTZ NOT NULL,
   attempts INTEGER NOT NULL DEFAULT 0
 )`);
 const hash=v=>crypto.createHmac('sha256',secret).update(v).digest('hex');
 return async function reserve({pin,ip='unknown'}={}){
   // Global + PIN-based + address-based bounds prevent distributed PIN guessing.
   const keys=[
     {key:hash('global'),limit:40},
     {key:hash('pin:'+String(pin)),limit:5},
     {key:hash('ip:'+String(ip)),limit:12}
   ];
   const client=await pool.connect();
   try{
     await client.query('BEGIN');
     // Transaction advisory lock avoids races between app replicas.
     await client.query('SELECT pg_advisory_xact_lock($1)',[90721921]);
     let blocked=false;
     for(const entry of keys){
       const q=await client.query(`
         INSERT INTO scanner_login_limits(key_hash,window_started,attempts)
         VALUES($1,now(),1)
         ON CONFLICT(key_hash) DO UPDATE SET
           window_started=CASE WHEN scanner_login_limits.window_started < now()-interval '15 minutes' THEN now() ELSE scanner_login_limits.window_started END,
           attempts=CASE WHEN scanner_login_limits.window_started < now()-interval '15 minutes' THEN 1 ELSE scanner_login_limits.attempts+1 END
         RETURNING attempts`,[entry.key]);
       if(Number(q.rows[0]?.attempts)>entry.limit)blocked=true;
     }
     await client.query('COMMIT');
     return !blocked;
   }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
   finally{client.release();}
 };
}
