const gateway='https://special-orders-test-production.up.railway.app';
const timeclock='https://timeclock-production-2bfa.up.railway.app';
const origin='chrome-extension://'+'a'.repeat(32);
async function check(label,url,body,expected,headers={}){
 const response=await fetch(url,{
   method:'POST',headers:{'Content-Type':'application/json',...headers},
   body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(12000)
 });
 console.log(label, response.status);
 if(!expected.includes(response.status))throw Error(label+' expected '+expected.join('/')+' but got '+response.status);
}
await check('Timeclock internal PIN verifier blocks public clients',
 timeclock+'/api/timeclock/integrations/scanner/verify-pin',{pin:'0000'},[403]);
await check('Scanner matching blocks unauthorized clients',
 gateway+'/api/scanner/matches',{product_code:'012345678901'},[401],{Origin:origin});
await check('Scanner PIN endpoint rejects invalid employee credentials',
 gateway+'/api/scanner/session',{pin:'0000'},[401,403],{Origin:origin});
console.log('Read-only scanner smoke tests passed. No product or employee data modified.');
