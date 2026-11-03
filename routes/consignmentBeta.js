import express from 'express';
import crypto from 'node:crypto';
import { createConsignmentMatcher } from '../services/consignmentMatcher.js';

const TYPES = new Set(['Game','Puzzle','RC','Train','Other']);
const STATUSES = new Set(['PENDING_REVIEW','APPROVED','REJECTED']);
const LIMIT = 30;
const clean=(s,max=200)=>String(s??'').trim().slice(0,max);
const emailValid=s=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const validMoney=x=>typeof x==='number'&&Number.isFinite(x)&&x>=0&&x<=1000000&&Math.round(x*100)===x*100;
function secureEqual(a,b){
 if(typeof a!=='string'||typeof b!=='string'||!a||!b)return false;
 const x=crypto.createHash('sha256').update(a).digest();
 const y=crypto.createHash('sha256').update(b).digest();
 return crypto.timingSafeEqual(x,y);
}
export function validateSubmission(body){
 if(!body||typeof body!=='object'||Array.isArray(body))throw Object.assign(new Error('Invalid submission'),{status:400});
 const customer=body.customer||{};
 const displayName=clean(customer.display_name,120);
 const email=clean(customer.email,180).toLowerCase();
 const phone=clean(customer.phone,35);
 if(!displayName||!emailValid(email)||!phone)throw Object.assign(new Error('Name, valid email, and phone required'),{status:400});
 const items=body.items;
 if(!Array.isArray(items)||!items.length||items.length>LIMIT)throw Object.assign(new Error('Submit 1–30 items'),{status:400});
 const parsed=items.map(i=>{
  if(!i||!TYPES.has(i.item_type)||!clean(i.name)||!validMoney(i.price))throw Object.assign(new Error('Each item requires type, name and valid price'),{status:400});
  if(!clean(i.condition)||!clean(i.inspection?.missing_status)||!clean(i.inspection?.smoking)||!clean(i.inspection?.basement_smell)||!Array.isArray(i.inspection?.pets))throw Object.assign(new Error('Item condition and household disclosures required'),{status:400});
  if(i.inspection.missing_status==='missing'&&!clean(i.inspection.missing_details))throw Object.assign(new Error('Missing parts must be described'),{status:400});
  if(['RC','Train'].includes(i.item_type)&&!clean(i.inspection.tested))throw Object.assign(new Error('Mechanical test status required'),{status:400});
  if(i.item_type==='Train'&&!clean(i.inspection.control))throw Object.assign(new Error('Train DC/DCC/Unknown required'),{status:400});
  return {item_type:i.item_type,name:clean(i.name,200),price:i.price,condition:clean(i.condition,80),inspection:i.inspection};
 });
 return {customer:{display_name:displayName,email,phone},items:parsed,source:body.source==='staff'?'staff':'online'};
}
export function createConsignmentBetaRouter({pool=null,staffKey=null,matchLookup=null,allowWrites=false}={}){
 const router=express.Router();
 router.use((req,res,next)=>{
  res.set('Cache-Control','no-store');
  if(!pool||!staffKey)return res.status(503).json({error:'Isolated consignment database and staff access are not configured.'});
  if(!secureEqual(req.get('x-consignment-staff-key'),staffKey))return res.status(401).json({error:'Staff authentication required.'});
  next();
 });
 router.get('/health',async(req,res)=>{
  try{await pool.query('SELECT 1');res.json({ok:true,isolated:true,lightspeedWrites:false,customerSync:false});}
  catch{res.status(503).json({error:'Database unavailable'});}
 });
 router.get('/submissions',async(req,res)=>{
  try{
   const page=Math.max(0,Math.min(10000,Number.parseInt(req.query.page||'0',10)||0));
   const {rows}=await pool.query('SELECT s.id,s.public_reference,s.source,s.status,s.submitted_at,s.created_at,c.display_name,c.email,c.phone, COUNT(i.id)::int AS item_count FROM consignment_submissions s JOIN consignment_customers c ON c.id=s.customer_id LEFT JOIN consignment_items i ON i.submission_id=s.id GROUP BY s.id,c.id ORDER BY s.created_at DESC LIMIT 50 OFFSET $1',[page*50]);
   res.json({submissions:rows,page});
  }catch{res.status(503).json({error:'Submission database unavailable'});}
 });
 router.get('/submissions/:id',async(req,res)=>{
  if(!/^\d{1,15}$/.test(req.params.id))return res.status(400).json({error:'Invalid ID'});
  try{
   const {rows}=await pool.query('SELECT i.id,i.consignment_code,i.item_type,i.submitted_name,i.asking_price,i.condition,i.inspection_data,i.status,i.template_id FROM consignment_items i WHERE submission_id=$1 ORDER BY id',[req.params.id]);
   res.json({items:rows});
  }catch{res.status(503).json({error:'Item database unavailable'});}
 });
 router.post('/submissions',async(req,res)=>{
  if(!allowWrites)return res.status(423).json({error:'Consignment test database writes are disabled.'});
  let body;try{body=validateSubmission(req.body)}catch(e){return res.status(e.status||400).json({error:e.message});}
  const client=await pool.connect().catch(()=>null);
  if(!client)return res.status(503).json({error:'Database unavailable'});
  try{
   await client.query('BEGIN');
   // Deliberately do not auto-match a Lightspeed customer based on email or name.
   // Identity collision review happens before any POS customer create.
   const c=await client.query('INSERT INTO consignment_customers(display_name,email,phone) VALUES($1,$2,$3) RETURNING id',[body.customer.display_name,body.customer.email,body.customer.phone]);
   const ref='SUB-'+crypto.randomUUID();
   const s=await client.query('INSERT INTO consignment_submissions(public_reference,customer_id,source,status,submitted_at) VALUES($1,$2,$3,$4,now()) RETURNING id,public_reference',[ref,c.rows[0].id,body.source,'PENDING_REVIEW']);
   for(const item of body.items){
    const code=({Game:'UG',Puzzle:'PZ',RC:'RC',Train:'TR',Other:'US'})[item.item_type]+'-'+crypto.randomUUID().replaceAll('-','').slice(0,12).toUpperCase();
    const ins=JSON.stringify(item.inspection);
    await client.query('INSERT INTO consignment_items(consignment_code,submission_id,item_type,submitted_name,asking_price,condition,inspection_data,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[code,s.rows[0].id,item.item_type,item.name,item.price,item.condition,ins,'PENDING_REVIEW']);
   }
   await client.query('COMMIT');
   res.status(201).json({submission:s.rows[0],itemCount:body.items.length,customerStatus:'UNMATCHED_REVIEW_REQUIRED'});
  }catch(e){await client.query('ROLLBACK').catch(()=>{});res.status(500).json({error:'Submission could not be saved'});}
  finally{client.release();}
 });
 router.post('/items/:id/review',async(req,res)=>{
  if(!allowWrites)return res.status(423).json({error:'Consignment test database writes are disabled.'});
  if(!/^\d{1,15}$/.test(req.params.id)||!STATUSES.has(req.body?.status))return res.status(400).json({error:'Invalid review request'});
  const client=await pool.connect().catch(()=>null);if(!client)return res.status(503).json({error:'Database unavailable'});
  try{
   await client.query('BEGIN');
   const item=await client.query("UPDATE consignment_items SET status=$1 WHERE id=$2 AND status='PENDING_REVIEW' RETURNING id,status",[req.body.status,req.params.id]);
   if(item.rowCount!==1){await client.query('ROLLBACK');return res.status(409).json({error:'Item no longer pending approval'});}
   await client.query('INSERT INTO consignment_item_events(item_id,actor_kind,actor_reference,event_kind,details) VALUES($1,$2,$3,$4,$5)',[req.params.id,'STAFF','beta-auth','REVIEW',JSON.stringify({status:req.body.status})]);
   await client.query('COMMIT');res.json({item:item.rows[0],lightspeedProductCreated:false});
  }catch{await client.query('ROLLBACK').catch(()=>{});res.status(500).json({error:'Review could not be completed'});}finally{client.release();}
 });
 router.post('/items/:id/matches',async(req,res)=>{
  if(!matchLookup)return res.status(503).json({error:'Authenticated product match gateway is not configured.'});
  if(!/^\d{1,15}$/.test(req.params.id))return res.status(400).json({error:'Invalid ID'});
  try{
   const {rows}=await pool.query('SELECT submitted_name FROM consignment_items WHERE id=$1',[req.params.id]);
   if(!rows.length)return res.status(404).json({error:'Item not found'});
   const match=createConsignmentMatcher({lookup:matchLookup});
   res.json(await match({name:rows[0].submitted_name}));
  }catch{res.status(502).json({error:'Could not verify both Lightspeed and local matching results.'});}
 });
 return router;
}
