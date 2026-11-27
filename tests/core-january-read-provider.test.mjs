import test from 'node:test';
import {createJanuaryReadProvider,createV10JanuaryReadProvider} from '../services/lightspeed/januaryReadProvider.js';
async function check(){
 const scope={tenant:'fictional',environment:'test',location:'outlet-001',sourceRef:'fixture'};
 const row={id:'000701',sku:'00000701',name:'Fictional model kit',price_excluding_tax:'19.99',supply_price:'10.00',product_codes:[{code:'000123456789',type:'UPC'}]};
 const inv=[{outlet_id:'outlet-001',current_amount:0}];
 const make=(patch={})=>createJanuaryReadProvider({scope,products:{get:async()=>({data:row})},inventory:{byProduct:async()=>inv},collection:async()=>[row],clock:()=>123,...patch});
 const assert=(v,label)=>{if(!v)throw Error(label);};
 const p=make();let n=0;
 const run=async(label,fn)=>{await fn();n++;};
 await run('exact product and raw price',async()=>{const r=await p.product('000701');assert(r.status==='OBSERVED'&&r.data.sku==='00000701'&&r.data.supply_price==='10.00'&&r.observedAt===123,'product')});
 await run('mismatched ID',async()=>assert((await p.product('701')).status==='INCOMPLETE','mismatch'));
 await run('numeric ID rejected',async()=>{let rejected=false;try{await p.product(701)}catch{rejected=true}assert(rejected,'numeric')});
 await run('zero preserved',async()=>assert((await p.quantities('000701')).data[0].current_amount===0,'zero'));
 await run('provider failure sanitized',async()=>{const r=await make({products:{get:async()=>{throw Error('private')}}}).product('000701');assert(r.status==='UNAVAILABLE'&&r.data===null&&!JSON.stringify(r).includes('private'),'failure')});
 await run('duplicate catalog ID incomplete',async()=>assert((await make({collection:async()=>[row,row]}).catalog()).status==='INCOMPLETE','dup'));
 await run('malformed catalog ID incomplete',async()=>assert((await make({collection:async()=>[{id:701}]}).catalog()).status==='INCOMPLETE','bad'));
 await run('traversal not namespace coverage',async()=>{const r=await p.catalog();assert(r.traversalFinished===true&&r.namespaceCoverageVerified===false,'coverage')});
 await run('defensive data copy',async()=>{const r=await p.product('000701');r.data.name='changed';assert((await p.product('000701')).data.name===row.name,'copy')});
 await run('invalid inventory response',async()=>assert((await make({inventory:{byProduct:async()=>null}}).quantities('000701')).status==='INCOMPLETE','inv'));
 await run('no mutation methods',async()=>assert(Object.keys(p).sort().join(',')==='catalog,product,quantities','methods'));
 return n;
}
test('January provider isolated cases',async()=>{if(await check()!==11)throw Error('Missing checks')});
test('V10 reader composition uses fixed GET paths',async()=>{const paths=[];const transport={request:async path=>{paths.push(path);if(path.includes('/inventory/'))return {data:[{outlet_id:'outlet-001',current_amount:0}]};if(path.includes('/products/'))return {data:{id:'000701'}};return {data:[],version:{max:0}};}};const p=createV10JanuaryReadProvider({transport,scope:{tenant:'fixture',environment:'test',location:'outlet-001',sourceRef:'fixture'}});if((await p.product('000701')).status!=='OBSERVED'||(await p.quantities('000701')).status!=='OBSERVED'||(await p.catalog()).status!=='OBSERVED'||paths.join('|')!=='/api/2.0/products/000701|/api/2026-04/inventory/000701|/api/2026-07/products?page_size=1000')throw Error('Unexpected paths');});
