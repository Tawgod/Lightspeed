import assert from 'node:assert/strict';
import {buildLabelPrintRequest} from '../Templates/label-print-request.mjs';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
const port=19089, base='http://127.0.0.1:'+port;
const child=spawn(process.execPath,['server.js'],{env:{...process.env,PORT:String(port),SCANNER_ENABLED:'false',DATABASE_URL:'',LIGHTSPEED_TOKEN:'',LIGHTSPEED_DOMAIN:''},stdio:['ignore','pipe','pipe']});
let logs='';
child.stdout.on('data',x=>logs+=x.toString());
child.stderr.on('data',x=>logs+=x.toString());
async function awaitReady(){
 for(let i=0;i<80;i++){
  if(child.exitCode!==null)throw Error('Server ended: '+logs.slice(-1600));
  try{const r=await fetch(base+'/');if(r.status<500)return;}catch{}
  await new Promise(r=>setTimeout(r,250));
 }
 throw Error('Server not ready: '+logs.slice(-1600));
}
async function render(name,startRow,startCol,items,prepared){
 const r=await fetch(base+'/api/labels/generate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(prepared ?? {poId:'SYNTHETIC',startRow,startCol,templateId:'Avery_5960',customText:'TEST',items})});
 assert.equal(r.status,200,'PDF endpoint succeeded'); // PDF only, no Lightspeed reads/writes
 assert.match(r.headers.get('content-type')||'',/application\/pdf/);
 const buffer=Buffer.from(await r.arrayBuffer());
 const raw=buffer.toString('latin1');
 assert.ok(raw.startsWith('%PDF-'),'PDF header');
 assert.ok(buffer.length>1800,'nonempty PDF');
 const count=(raw.match(/\/Type\s*\/Page\b/g)||[]).length;
 assert.ok(count>=1,'at least one page');
 assert.match(raw,/\/MediaBox\s*\[\s*0\s+0\s+612\s+792\s*\]/,'US letter PDF page');
 assert.match(raw,/\/Subtype\s*\/Image/,'barcode rendered as image');
 await writeFile('label-pdf-artifacts/'+name+'.pdf',buffer);
 console.log('PASS',name,'pages=',count,'bytes=',buffer.length);
 return count;
}
try{
 await awaitReady();
 await mkdir('label-pdf-artifacts',{recursive:true});
 const regular=[{name:'Test model kit',sku:'0000412305',price:'$8.99',qty:3,soQty:0,customerName:''}];
 const mixed=[{name:'Long descriptive test item model kit for wrapping behavior',sku:'0000067891',price:'$12.99',qty:2,soQty:1,customerName:'Synthetic Customer'}];
 await render('avery5960-regular',1,1,regular);
 await render('avery5960-start-row3-col2',3,2,mixed);
 const pages=await render('avery5960-multipage',1,1,[{name:'Synthetic Bulk Stock',sku:'0000054321',price:'$4.00',qty:32,soQty:0,customerName:''}]);
 assert.equal(pages,2,'32 labels create two pages');
 const templates=await fetch(base+'/api/templates');
 assert.equal(templates.status,200);
 const discovered=await templates.json();
 assert.ok(discovered.some(t=>t.id==='Avery_5960'));
 const selected=buildLabelPrintRequest({startRow:10,startCol:3,customText:'TEST',items:[{name:'Fictional paint',sku:'0000000123',price:'$4.99',qty:2},{name:'Skipped fixture',sku:'0000000456',price:'$8.99',qty:0}]});
 assert.equal(selected.items.length,1);
 assert.equal(selected.items[0].sku,'0000000123');
 assert.equal(await render('selected-products-partial-overflow',10,3,selected.items,selected),2);
 console.log('PASS 4 representative PDFs including selected-product adapter; exact API and backend exercised');
} finally {child.kill('SIGTERM');}
