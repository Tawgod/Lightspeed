import {createHmac,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';

// Candidate only. A Discord role may initiate an invitation, but NEVER
// authorizes an authenticator seed, factor reset or privileged backend action.
// Existing independently verified manager approval is still required.
const STAFF=/^[1-9][0-9]{0,17}$/;
const SNOWFLAKE=/^[0-9]{15,22}$/;
const TOKEN=/^[A-Za-z0-9_-]{43}$/;
const banned=()=>Object.assign(new Error('Enrollment invitation denied.'),{
  status:403,code:'HC_INVITATION_DENIED'
});
const down=()=>Object.assign(new Error('Enrollment invitation unavailable.'),{
  status:503,code:'HC_INVITATION_UNAVAILABLE'
});
const exists=()=>Object.assign(new Error('Invitation already redeemed.'),{
  status:409,code:'HC_INVITATION_USED'
});
export function createStaffEnrollmentInvitations({
  pool,botSecret,tokenSecret,guildId,staffRoleId,adminRoleId,ownerRoleId,
  setupOrigin,verifyBoundEmployee,resolveDiscordEmployee,
  canInvite,requestEnrollment,throttle,ownerOnlyTest=null,environment=process.env,now=()=>Date.now()
}={}){
  if(typeof pool?.connect!=='function'||
    typeof botSecret!=='string'||Buffer.byteLength(botSecret)<32||
    typeof tokenSecret!=='string'||Buffer.byteLength(tokenSecret)<32||
    !SNOWFLAKE.test(String(guildId||''))||
    (ownerOnlyTest===null ? (
      ![staffRoleId,adminRoleId,ownerRoleId].every(x=>SNOWFLAKE.test(String(x||'')))||
      new Set([staffRoleId,adminRoleId,ownerRoleId]).size!==3
    ) : !(
      environment?.HC_SECURITY_ENV==='isolated-staging'&&
      ownerOnlyTest?.environment==='isolated-staging'&&
      ownerOnlyTest?.ownerDiscordId==='115626919134887940'&&
      guildId==='1485804234753573066'&&
      ownerOnlyTest?.channelId==='1566905099429744700'
    ))||
    [verifyBoundEmployee,resolveDiscordEmployee,canInvite,requestEnrollment,now]
      .some(x=>typeof x!=='function')||
    typeof throttle?.reserve!=='function')
      throw new TypeError('Trusted Discord bot, exact roles, Timeclock linking and persistent store required.');
  let targetOrigin;
  try {targetOrigin=new URL(setupOrigin);}catch{throw new TypeError('An exact secure setup origin is required.');}
  if(targetOrigin.origin!==setupOrigin||
     (targetOrigin.protocol!=='https:'&&
       !(targetOrigin.protocol==='http:'&&targetOrigin.hostname==='localhost'))||
     targetOrigin.username||targetOrigin.password)
    throw new TypeError('Setup URL must be exact HTTPS origin or local test origin.');
  const secretHash=raw=>createHmac('sha256',tokenSecret)
    .update('hc:staff:bot-invite:v1:'+raw).digest('hex');
  const same=(a,b)=>{
    const x=Buffer.from(typeof a==='string'?a:'');
    const y=Buffer.from(b);
    return x.length===y.length && timingSafeEqual(x,y);
  };
  const millis=()=>{const x=now();if(!Number.isSafeInteger(x)||x<0)throw down();return x;};
  const date=x=>new Date(x).toISOString();
  async function transaction(fn){
    let c;
    try{
      c=await pool.connect();await c.query('BEGIN');
      const answer=await fn(c);await c.query('COMMIT');return answer;
    }catch(err){
      if(c)await c.query('ROLLBACK').catch(()=>{});
      if(err?.code==='HC_INVITATION_DENIED'||err?.code==='HC_INVITATION_USED')throw err;
      throw down();
    }finally{c?.release();}
  }
  async function lookup(discordId){
    let employee;
    try{employee=await resolveDiscordEmployee(discordId);}catch{throw banned();}
    if(employee?.active!==true||!STAFF.test(String(employee.id||''))||
       String(employee.discordUserId)!==discordId)throw banned();
    return String(employee.id);
  }
  async function reserve(employeeId,ip){
    let ok=false;
    try{ok=await throttle.reserve({employeeId,sourceIp:ip})===true;}catch{throw down();}
    if(!ok)throw banned();
  }
  async function issue({botCredential,guild,channelId,actorDiscordId,targetDiscordId,roleIds,sourceIp}={}){
    // Credentials authenticate trusted bot-to-backend transport, not a manager
    // passkey. Treat all other payload fields as assertions to validate.
    if(!same(botCredential,botSecret)||
       guild!==guildId||!SNOWFLAKE.test(String(actorDiscordId||''))||
       !SNOWFLAKE.test(String(targetDiscordId||''))||
       !Array.isArray(roleIds)||roleIds.length>100||
       !roleIds.every(r=>typeof r==='string'&&SNOWFLAKE.test(r))||
       !(ownerOnlyTest!==null ?
         (actorDiscordId===ownerOnlyTest.ownerDiscordId&&
          targetDiscordId===ownerOnlyTest.ownerDiscordId&&
          channelId===ownerOnlyTest.channelId&&roleIds.length===0) :
         (roleIds.includes(adminRoleId)||roleIds.includes(ownerRoleId))))
      throw banned();
    const actor=await lookup(actorDiscordId),target=await lookup(targetDiscordId);
    await reserve(actor,sourceIp);
    let permitted=false;
    try{permitted=await canInvite({
      approverId:actor,employeeId:target,actorDiscordId,
      targetDiscordId,guildId,operation:'staff.authenticator.invite'
    })===true;}catch{ /* fail closed */ }
    if(!permitted)throw banned();
    const raw=randomBytes(32).toString('base64url');
    const invitationId=randomUUID(),expiresAtMs=millis()+15*60_000;
    await transaction(async c=>{
      await c.query(
        'INSERT INTO hc_staff_security_invitations(invitation_id,token_hash,employee_id,invited_by_employee_id,actor_discord_id,target_discord_id,guild_id,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [invitationId,secretHash(raw),target,actor,actorDiscordId,targetDiscordId,guildId,date(expiresAtMs)]
      );
      await c.query(
        "INSERT INTO hc_staff_security_invitation_events(event_id,invitation_id,kind,actor_employee_id) VALUES($1,$2,'issued',$3)",
        [randomUUID(),invitationId,actor]
      );
    });
    // Fragment isn't transmitted in HTTP request logs or Referer. Browser
    // removes it from address bar before contacting the server.
    const link=setupOrigin+'/staff-security/#invite='+raw;
    return Object.freeze({invitationId,link,expiresAtMs,employeeId:target});
  }
  async function redeem({context,token,sourceIp}={}){
    if(typeof token!=='string'||!TOKEN.test(token))throw banned();
    let person;
    try{person=await verifyBoundEmployee(context);}catch{throw banned();}
    const id=String(person?.id||person?.employeeId||'');
    if(person?.active!==true||!STAFF.test(id)||
       typeof person.binding!=='string'||person.binding.length<16||
       !Number.isSafeInteger(person.expiresAtMs)||person.expiresAtMs<=millis())
      throw banned();
    await reserve(id,sourceIp);
    return transaction(async c=>{
      const q=await c.query(
        'SELECT invitation_id,employee_id,expires_at,consumed_at,enrollment_request_id FROM hc_staff_security_invitations WHERE token_hash=$1 FOR UPDATE',
        [secretHash(token)]);
      const row=q.rows?.[0];
      if(!row||String(row.employee_id)!==id||
         new Date(row.expires_at).getTime()<=millis())throw banned();
      if(row.consumed_at)throw exists();
      // While holding the invitation lock, issue the original session-bound
      // enrollment request. No seed is created and manager approval remains
      // mandatory. On failure the invitation is NOT consumed.
      const request=await requestEnrollment({context,sourceIp});
      if(typeof request?.requestId!=='string')throw down();
      await c.query(
        'UPDATE hc_staff_security_invitations SET consumed_at=now(),enrollment_request_id=$2 WHERE invitation_id=$1',
        [row.invitation_id,request.requestId]);
      await c.query(
        "INSERT INTO hc_staff_security_invitation_events(event_id,invitation_id,kind,actor_employee_id) VALUES($1,$2,'redeemed',$3)",
        [randomUUID(),row.invitation_id,id]
      );
      return Object.freeze({
        requestId:request.requestId,state:'requested',
        expiresAtMs:request.expiresAtMs
      });
    });
  }
  return Object.freeze({issue,redeem});
}
