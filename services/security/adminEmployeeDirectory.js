// Employee directory projection for administration. Timeclock is authoritative.
// Never send an unfiltered Timeclock /admin/employees payload to a browser.
// Read-only and independent of onboarding privileges.
const idPattern=/^[1-9][0-9]{0,17}$/;
const NAME_MAX=140;
const fail=(code,message)=>Object.assign(new Error(message),{status:code});
const accepted=(row,includePrivate)=>{
 if(!row||typeof row!=='object'||Array.isArray(row))throw fail(503,'Malformed employee record');
 const id=String(row.id||'');
 const name=typeof row.name==='string'?row.name.trim():'';
 if(!idPattern.test(id)||name.length<1||name.length>NAME_MAX||typeof row.active!=='boolean')
  throw fail(503,'Malformed employee record');
 const item={id,name,active:row.active};
 if(includePrivate){
  if(typeof row.has_pin!=='boolean'||typeof row.pto_eligible!=='boolean')
   throw fail(503,'Missing private employee status');
  item.hasPin=row.has_pin;
  item.ptoEligible=row.pto_eligible;
  item.scannerCanLookup=row.scanner_can_lookup===true;
  item.scannerCanApprove=row.scanner_can_approve===true;
  item.lightspeedLinked=typeof row.lightspeed_user_id==='string'
   ?row.lightspeed_user_id.length>0:row.lightspeed_user_id!=null;
  item.discordLinked=row.discord_user_id!=null&&String(row.discord_user_id).length>0;
 }
 return Object.freeze(item);
};
export function createAdminEmployeeDirectory({readTimeclockEmployees}={}){
 if(typeof readTimeclockEmployees!=='function')
  throw new TypeError('A vetted server-side Timeclock read-only employee adapter is required.');
 async function list({includePrivate=false}={}){
  if(typeof includePrivate!=='boolean')throw fail(400,'Invalid directory scope.');
  let result;
  try{result=await readTimeclockEmployees();}
  catch{throw fail(503,'Timeclock directory unavailable.');}
  if(!Array.isArray(result)||result.length>5000)
   throw fail(503,'Timeclock directory response unavailable.');
  const seen=new Set();
  const employees=result.map(row=>{
   const item=accepted(row,includePrivate);
   if(seen.has(item.id))throw fail(503,'Duplicate employee IDs returned.');
   seen.add(item.id);
   return item;
  });
  return Object.freeze({
   employees:Object.freeze(employees),
   count:employees.length,
   scope:includePrivate?'private':'directory',
   source:'timeclock',
   readOnly:true
  });
 }
 return Object.freeze({list});
}
