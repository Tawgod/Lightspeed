// Run on a Railway service before setting SCANNER_ENABLED=true.
// Never prints credentials, tokens, connection strings, or PINs.
const service=process.env.RAILWAY_SERVICE_NAME||'';
const fail=[];
const has=k=>typeof process.env[k]==='string'&&process.env[k].length>0;
const strong=k=>typeof process.env[k]==='string'&&Buffer.byteLength(process.env[k])>=32;

if(service==='timeclock'){
  if(!has('DATABASE_URL'))fail.push('DATABASE_URL');
  if(!has('TIMECLOCK_PIN_PEPPER'))fail.push('TIMECLOCK_PIN_PEPPER');
  if(!strong('SCANNER_SERVICE_SECRET'))fail.push('SCANNER_SERVICE_SECRET (32+ bytes)');
}else if(service==='special-orders-test'){
  if(!has('DATABASE_URL'))fail.push('DATABASE_URL');
  if(!has('SPECIAL_ORDERS_ADMIN_KEY'))fail.push('SPECIAL_ORDERS_ADMIN_KEY');
  for(const k of ['SCANNER_SERVICE_SECRET','SCANNER_SESSION_SECRET','SCANNER_LOGIN_LIMIT_SECRET']){
    if(!strong(k))fail.push(k+' (32+ bytes)');
  }
  const origin=process.env.SCANNER_TIMECLOCK_ORIGIN||'';
  try {
    const u=new URL(origin);
    if(u.protocol!=='https:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw Error('bad URL');
  }catch {fail.push('SCANNER_TIMECLOCK_ORIGIN (HTTPS service origin)');}
}else{
  fail.push('Use only Railway service timeclock or special-orders-test');
}
if(process.env.SCANNER_ENABLED==='true' && service!=='special-orders-test'){
  fail.push('SCANNER_ENABLED must only be true on special-orders-test');
}
if(fail.length){
  console.error('Scanner configuration incomplete: '+fail.join('; '));
  process.exitCode=1;
}else{
  console.log('Scanner configuration valid for '+service+
    '; enabled='+String(process.env.SCANNER_ENABLED==='true')+
    '. No secrets displayed.');
}
