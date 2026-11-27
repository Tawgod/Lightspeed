// PostgreSQL 18 startup gate for the dedicated operational schema.
// Expected runtime role is trusted deployment configuration, never a request value.
export async function verifyOperationalPrivileges({pool,runtimeRole}={}){
 const deny=()=>new Error('Operational database privileges refused');
 if(!pool?.connect||typeof runtimeRole!=='string'||!runtimeRole)throw deny();
 const c=await pool.connect();
 try{
 const r=await c.query(`SELECT current_user AS role,current_setting('server_version_num')::int AS version,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,has_schema_privilege(current_user,'hc_security_operational','CREATE') AS ddl,has_schema_privilege(current_user,'hc_security_operational','USAGE') AS usage FROM pg_roles WHERE rolname=current_user`);
 const x=r.rows[0];
 if(r.rowCount!==1||x.role!==runtimeRole||x.version<180000||x.version>=190000||!x.usage||['rolsuper','rolcreatedb','rolcreaterole','rolreplication','rolbypassrls','ddl'].some(k=>x[k]!==false))throw deny();
 for(const t of ['authority','employee','session','audit']){
 const q=await c.query(`SELECT has_table_privilege(current_user,$1,'SELECT') AS r,has_table_privilege(current_user,$1,'INSERT') AS i,has_table_privilege(current_user,$1,'UPDATE') AS u,has_table_privilege(current_user,$1,'DELETE') AS d,has_table_privilege(current_user,$1,'TRUNCATE') AS tr,has_table_privilege(current_user,$1,'TRIGGER') AS tg,has_table_privilege(current_user,$1,'REFERENCES') AS ref,has_any_column_privilege(current_user,$1,'UPDATE') AS cu`,['hc_security_operational.'+t]);
 const a=q.rows[0];
 if(q.rowCount!==1||a.r!==(t!=='audit')||a.i!==(t==='session'||t==='audit')||a.u||a.d||a.tr||a.tg||a.ref||a.cu!==(t==='session'))throw deny();
 if(t==='session'){
 const v=await c.query(`SELECT attname,has_column_privilege(current_user,'hc_security_operational.session',attname,'UPDATE') AS u FROM pg_attribute WHERE attrelid='hc_security_operational.session'::regclass AND attnum>0 AND NOT attisdropped`);
 if(v.rowCount!==6||v.rows.some(z=>z.u!==(z.attname==='revoked')))throw deny();
 }
 }
 return Object.freeze({ready:true});
 }catch{throw deny()}finally{c.release()}
}
