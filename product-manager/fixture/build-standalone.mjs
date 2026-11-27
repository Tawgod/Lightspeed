// Build a single-file, offline, fixture-only owner test interface.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const here=new URL('.',import.meta.url);
const read=name=>fs.readFileSync(new URL(name,here),'utf8');
export function buildStandalone(){
 const script="'use strict';\n"+['label-print-request.mjs','catalogJanuaryLookup.mjs','fixture-runtime.mjs','app.js'].map(name=>read(name).replace(/^import[^\n]+\n/gm,'').replace(/^export /gm,'')).join('\n');
 if(/<\/script/i.test(script))throw Error('Unexpected closing script tag in fixture source');
 const hash=createHash('sha256').update(script,'utf8').digest('base64');
 const css=read('styles.css');if(/<\/style/i.test(css))throw Error('Unexpected closing style tag');
 const html=read('index.html').replace("script-src 'self'",`script-src 'sha256-${hash}'`).replace('<link rel="stylesheet" href="styles.css">',()=>`<style>${css}</style>`).replace('<script type="module" src="app.js"></script>',()=>`<script>${script}</script>`);
 if(!html.includes(hash)||!html.includes(script)||html.includes('src="app.js"'))throw Error('Standalone build failed');
 return {html,script,hash};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const dest=process.argv[2]||'Product_Manager_January_Fixture.html';fs.writeFileSync(dest,buildStandalone().html);console.log('Built '+dest)}
