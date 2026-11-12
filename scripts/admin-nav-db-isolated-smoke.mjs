import pg from 'pg';
import {verifyAdminNavigationReadOnlyDatabase,createAdminNavigationGrantReader} from '../services/security/adminNavigationAccess.js';

// One-time non-mutating probe for the dedicated isolated Admin grants DB.
// This NEVER seeds employee IDs or grants and has no HTTP route.
const fail=message=>{throw new Error('Admin navigation isolated smoke refused: '+message);};
export function validateAdminSmokeTarget(env){
 if(env.HC_ADMIN_NAV_SMOKE_ENABLED!=='true'||env.HC_ADMIN_NAV_SMOKE_ENVIRONMENT!=='test'||
    env.HC_ADMIN_NAV_SMOKE_TARGET!=='Postgres-O39p')
  fail('missing isolated test-only opt-in');
 const host=env.HC_ADMIN_NAV_SMOKE_HOST;
 const database=env.HC_ADMIN_NAV_SMOKE_DATABASE;
 if(typeof host!=='string'||!host.endsWith('.railway.internal')||
    typeof database!=='string'||!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(database))
  fail('unexpected private database endpoint');
 const password=env.HC_ADMIN_NAV_READER_PASSWORD;
 if(typeof password!=='string'||password.length<48||!(/^[A-Za-z0-9_-]+$/.test(password)))
  fail('reader password unavailable');
 return Object.freeze({host,database,password});
}
export async function verifyIsolatedAdminNavigation({env=process.env,poolFactory=opts=>new pg.Pool(opts)}={}){
 const target=validateAdminSmokeTarget(env);
 const pool=poolFactory({
  host:target.host,database:target.database,port:5432,
  user:'hc_admin_nav_reader',password:target.password,
  max:1,connectionTimeoutMillis:5000,statement_timeout:5000,
  application_name:'hc-admin-nav-readonly-smoke'
 });
 try{
  const db=await pool.query('SELECT current_database() AS database, current_user AS login');
  if(db.rowCount!==1||db.rows[0]?.database!==target.database||
     db.rows[0]?.login!=='hc_admin_nav_reader')fail('not connected as the restricted reader');
  if(!await verifyAdminNavigationReadOnlyDatabase({pool}))
   fail('database principal does not satisfy SELECT-only preflight');
  const principal=await pool.query('SELECT count(*)::integer AS n FROM hc_admin_principals');
  const grants=await pool.query('SELECT count(*)::integer AS n FROM hc_admin_grants');
  if(principal.rows[0]?.n!==0||grants.rows[0]?.n!==0)
   fail('unexpected Owner or delegated grant data');
  const read=createAdminNavigationGrantReader({pool});
  if(await read({employeeId:'901',operation:'admin.read'}))
   fail('synthetic employee unexpectedly authorized');
  return Object.freeze({readOnlyConnected:true,principals:0,grants:0,service:'Postgres-O39p'});
 }finally{await pool.end();}
}
if(import.meta.url===new URL('file://'+process.argv[1]).href){
 verifyIsolatedAdminNavigation().then(()=>{
  console.log('Admin navigation isolated read-only connection PASS; zero principals and grants.');
 }).catch(error=>{console.error(error.message);process.exitCode=1});
}
