import crypto from 'node:crypto';

// Short-lived server-signed scanner tokens. These are not Timeclock PINs.
// The API re-checks current permissions with Timeclock before each lookup.
export function createScannerSessions({secret,ttlSeconds=900,now=()=>Date.now()}={}){
  if(typeof secret!=='string'||Buffer.byteLength(secret)<32)throw new Error('SCANNER_SESSION_SECRET must be at least 32 bytes.');
  const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const sign=body=>crypto.createHmac('sha256',secret).update(body).digest('base64url');
  function issue(employee){
    if(!Number.isSafeInteger(Number(employee?.id))||Number(employee.id)<=0)throw new Error('Invalid employee.');
    const payload=encode({sub:String(employee.id),exp:Math.floor(now()/1000)+ttlSeconds,iat:Math.floor(now()/1000),jti:crypto.randomBytes(16).toString('hex')});
    return payload+'.'+sign(payload);
  }
  function verify(token){
    if(typeof token!=='string'||token.length>2048)throw Object.assign(new Error('Scanner session required.'),{status:401});
    const parts=token.split('.');
    if(parts.length!==2)throw Object.assign(new Error('Invalid scanner session.'),{status:401});
    const [body,sig]=parts;
    const expected=sign(body);
    if(sig.length!==expected.length||!crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(expected))){
      throw Object.assign(new Error('Invalid scanner session.'),{status:401});
    }
    let payload;
    try{payload=JSON.parse(Buffer.from(body,'base64url').toString('utf8'))}catch{throw Object.assign(new Error('Invalid scanner session.'),{status:401})}
    if(!/^\d+$/.test(String(payload?.sub||''))||!Number.isSafeInteger(Number(payload.sub))||!Number.isFinite(payload?.exp)||payload.exp<=Math.floor(now()/1000)){
      throw Object.assign(new Error('Expired scanner session.'),{status:401});
    }
    return {employeeId:Number(payload.sub)};
  }
  return {issue,verify,ttlSeconds};
}
