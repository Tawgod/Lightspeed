import {createPublicKey,randomUUID,timingSafeEqual} from 'node:crypto';

// One-time test-only operator-assisted enrollment. This is NOT WebAuthn,
// Owner commissioning, an IdP or an accepted staff station registration path.
// A high-entropy, operator-held key is required IN ADDITION TO the isolated,
// signed synthetic employee session, a durable throttle and one-use DB row.
const EMPLOYEE_ID='901';
const APPROVER_ID='900';
const b64=/^[A-Za-z0-9_-]+$/;
function equal(expected,provided){
  if(typeof expected!=='string'||typeof provided!=='string'||
     !/^[A-Za-z0-9_-]{43,128}$/.test(expected)||
     provided.length!==expected.length)return false;
  return timingSafeEqual(Buffer.from(expected),Buffer.from(provided));
}
function validatePublicKey(value){
  if(typeof value!=='string'||value.length>128||!b64.test(value))return null;
  try{
    const der=Buffer.from(value,'base64url');
    const key=createPublicKey({key:der,format:'der',type:'spki'});
    if(key.asymmetricKeyType!=='ed25519'||der.length!==44||
       key.export({format:'der',type:'spki'}).toString('base64url')!==value)
       return null;
    return der;
  }catch{return null;}
}
export function createIsolatedPilotOperator({
  pool,staffAuthGateway,loginThrottle,operatorKey
}={}){
  if(typeof pool?.connect!=='function'||
     typeof staffAuthGateway?.verifyBoundEmployee!=='function'||
     typeof loginThrottle?.reserve!=='function'||
     !/^[A-Za-z0-9_-]{43,128}$/.test(String(operatorKey||'')))
    throw new TypeError('Isolated operator requires trusted staff, durable throttle and independent key.');
  async function register({request,publicKeySpki,label}={}){
    let bound;
    try{bound=await staffAuthGateway.verifyBoundEmployee(request);}catch{return null;}
    if(String(bound?.employeeId)!==EMPLOYEE_ID||bound.active!==true)return null;
    let accepted=false;
    try{
      accepted=await loginThrottle.reserve({employeeId:APPROVER_ID,sourceIp:request.ip})===true;
    }catch{return null;}
    if(!accepted||!equal(operatorKey,request.get('x-hc-pilot-operator-key')))return null;
    const publicKey=validatePublicKey(publicKeySpki);
    if(!publicKey||typeof label!=='string'||label.trim().length<3||
      label.trim().length>80||/[^ -~]/.test(label))return null;
    let client;
    try{
      client=await pool.connect();
      await client.query('BEGIN');
      const claimed=await client.query(
        'UPDATE public.hc_pilot_device_registration SET consumed_at=now() '+
        'WHERE id=1 AND consumed_at IS NULL RETURNING id');
      if(claimed.rowCount!==1)throw Error('Operator registration already consumed.');
      const deviceId=randomUUID();
      await client.query(
        'INSERT INTO public.hc_staff_stations(device_id,public_key_spki,label,registered_by) '+
        'VALUES($1,$2,$3,$4)',[deviceId,publicKey,label.trim(),APPROVER_ID]);
      await client.query(
        "INSERT INTO public.hc_staff_station_events(event_id,device_id,actor_id,kind) "+
        "VALUES($1,$2,$3,'registered')",
        [randomUUID(),deviceId,APPROVER_ID]);
      await client.query('UPDATE public.hc_pilot_device_registration SET device_id=$1 WHERE id=1',
        [deviceId]);
      await client.query('COMMIT');
      return Object.freeze({registered:true,deviceId});
    }catch{
      if(client)await client.query('ROLLBACK').catch(()=>{});
      return null;
    }finally{client?.release();}
  }
  return Object.freeze({register});
}
