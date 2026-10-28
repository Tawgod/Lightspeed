import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createProductManagerProfilesRouter,validateWorkDraft} from './profiles-api.js';

test('staff-owned profile and backup HTTP routes isolate employees and reject revoked sessions',async()=>{
 const profiles=new Map(), backups=new Map();
 const pool={async query(sql,args=[]){
  const [id,slot,raw]=args;
  if(sql.includes('FROM product_manager_profiles WHERE'))return {rows:[...profiles.entries()].filter(([key])=>key.startsWith(id+':')).map(([key,config])=>({slot:key.split(':')[1],config,updated_at:new Date().toISOString()}))};
  if(sql.includes('INSERT INTO product_manager_profiles')){const config=JSON.parse(raw);profiles.set(id+':'+slot,config);return {rows:[{slot,config,updated_at:new Date().toISOString()}]}};
  if(sql.includes('FROM product_manager_work_drafts WHERE'))return {rows:backups.has(id)?[{payload:backups.get(id),updated_at:new Date().toISOString()}]:[]};
  if(sql.includes('INSERT INTO product_manager_work_drafts')){const payload=JSON.parse(slot);const old=backups.get(id);
    if(old&&old.savedAt>payload.savedAt)return {rows:[]};
    backups.set(id,payload);return {rows:[{updated_at:new Date().toISOString()}]};}
  throw Error('Unexpected query '+sql);
 }};
 const app=express();const active=new Set([1,2]);
 app.use('/api/product-manager',createProductManagerProfilesRouter({pool,verifyEmployee:async req=>{
  const raw=req.get('authorization');const id=raw==='Bearer employee1'?1:raw==='Bearer employee2'?2:null;
  if(!id)throw Object.assign(Error('No session'),{status:401});
  if(!active.has(id))throw Object.assign(Error('Revoked'),{status:403});
  return {id};
 }}));
 const server=app.listen(0,'127.0.0.1');
 try{
  await new Promise(resolve=>server.once('listening',resolve));
  const root='http://127.0.0.1:'+server.address().port+'/api/product-manager';
  async function request(token,path,method='GET',body){
   const r=await fetch(root+path,{method,headers:{authorization:token?'Bearer '+token:'','content-type':'application/json'},body:body?JSON.stringify(body):undefined});
   return {status:r.status,body:await r.json()};
  }
  const config={columns:['sku','name'],hidden:['name'],widths:{sku:140},detailsOrder:[]};
  assert.equal((await request('employee1','/profiles/Profile%201','PUT',{config})).status,200);
  assert.equal((await request('employee2','/profiles')).body.profiles.length,0);
  assert.equal((await request('employee1','/profiles')).body.profiles.length,1);
  const backup={changes:[{productId:'p',field:'name',oldValue:'Before',newValue:'After'}],layout:config,slot:'Profile 1',selection:'p',filter:'000012',savedAt:200};
  assert.equal(validateWorkDraft(backup),true);
  assert.equal((await request('employee1','/work-draft','PUT',{payload:backup})).status,200);
  assert.equal((await request('employee2','/work-draft')).body.draft,null);
  assert.equal((await request('employee1','/work-draft','PUT',{payload:{...backup,savedAt:100}})).status,409);
  assert.equal((await request('employee1','/work-draft')).body.draft.payload.savedAt,200);
  assert.equal((await request('employee1','/work-draft','PUT',{payload:{...backup,changes:[{...backup.changes[0],employeeId:2}]}})).status,400);
  assert.equal((await request(null,'/profiles')).status,401);
  active.delete(1);
  assert.equal((await request('employee1','/profiles')).status,403);
  assert.equal((await request('employee1','/work-draft')).status,403);
 }finally{await new Promise(resolve=>server.close(resolve))}
});
