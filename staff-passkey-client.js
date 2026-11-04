(() => {
  'use strict';
  // UNMOUNTED manual pilot UI. All tokens stay in memory; no local/session
  // storage or extension APIs. PIN sign-in alone can never enroll a passkey.
  const byId = id => document.getElementById(id);
  let baseToken = null, proofToken = null, proofExpires = 0, busy = false;
  const b64bytes = text => {
    if (typeof text !== 'string' || !/^[A-Za-z0-9_-]+$/.test(text)) throw Error('Invalid security challenge.');
    const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
    const str = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '='));
    return Uint8Array.from(str, letter => letter.charCodeAt(0));
  };
  const toB64 = binary => {
    const array = new Uint8Array(binary);
    let chars = '';
    for (const byte of array) chars += String.fromCharCode(byte);
    return btoa(chars).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  };
  const show = (msg, isError = false) => {
    const el = byId('message');
    el.textContent = msg;
    el.dataset.error = isError ? 'true' : 'false';
  };
  function clearProof() {
    proofToken = null;
    proofExpires = 0;
    byId('proof').textContent = 'Not verified';
    byId('managerApproval').disabled = true;
  }
  function refresh() {
    byId('registerPasskey').disabled = !baseToken || busy;
    byId('verifyPasskey').disabled = !baseToken || busy;
    byId('signout').disabled = !baseToken || busy;
    byId('managerApproval').disabled = !baseToken || !proofToken ||
      proofExpires <= Date.now() || busy;
  }
  async function send(endpoint, data, extra = {}) {
    const response = await fetch(endpoint, {
      method: 'POST',cache:'no-store',mode:'same-origin',credentials:'omit',
      headers:{
        'Content-Type':'application/json',
        ...(baseToken ? {'Authorization':'Bearer '+baseToken} : {}),
        ...extra
      },
      body:JSON.stringify(data)
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw Error(response.status === 403
      ? 'Independent verification or enrollment approval is required.'
      : response.status === 429 ? 'Too many attempts. Try later.'
      : String(json.error || 'Verification unavailable.'));
    return json;
  }
  function registrationOptions(options) {
    if (!options?.challenge || !options?.user?.id) throw Error('Invalid registration options.');
    return {
      ...options,
      challenge:b64bytes(options.challenge),
      user:{...options.user,id:b64bytes(options.user.id)},
      excludeCredentials:(options.excludeCredentials || []).map(c => ({
        ...c,id:b64bytes(c.id)
      }))
    };
  }
  function authenticationOptions(options) {
    if (!options?.challenge) throw Error('Invalid authentication options.');
    return {
      ...options,challenge:b64bytes(options.challenge),
      allowCredentials:(options.allowCredentials || []).map(c => ({
        ...c,id:b64bytes(c.id)
      }))
    };
  }
  function wrapRegistration(credential) {
    return {
      id:credential.id,rawId:toB64(credential.rawId),type:credential.type,
      response:{
        clientDataJSON:toB64(credential.response.clientDataJSON),
        attestationObject:toB64(credential.response.attestationObject),
        transports:typeof credential.response.getTransports==='function'
          ? credential.response.getTransports() : []
      },
      clientExtensionResults:credential.getClientExtensionResults()
    };
  }
  function wrapAuthentication(credential) {
    return {
      id:credential.id,rawId:toB64(credential.rawId),type:credential.type,
      response:{
        clientDataJSON:toB64(credential.response.clientDataJSON),
        authenticatorData:toB64(credential.response.authenticatorData),
        signature:toB64(credential.response.signature),
        userHandle:credential.response.userHandle
          ? toB64(credential.response.userHandle) : null
      },
      clientExtensionResults:credential.getClientExtensionResults()
    };
  }
  async function run(action) {
    if (busy) return;
    busy = true;refresh();
    try {await action();}
    catch (error) {show(error.message || 'Verification could not be completed.',true);}
    finally {busy=false;refresh();}
  }
  byId('login').addEventListener('submit',event=>{
    event.preventDefault();
    run(async()=>{
      const pin = byId('pin').value;
      byId('pin').value = '';
      if (!/^\d{4}$/.test(pin)) throw Error('Enter your four-digit Timeclock PIN.');
      const info = await send('/api/staff-auth/session',{pin});
      if(typeof info.token!=='string'||!info.employee?.id)throw Error('Signed employee session unavailable.');
      baseToken = info.token;
      clearProof();
      byId('identity').textContent = 'Signed in as '+String(info.employee.name || 'employee');
      show('Signed in. Enrollment still requires an independently approved authorization.');
    });
  });
  byId('registerPasskey').addEventListener('click',()=>{
    run(async()=>{
      if(!baseToken)throw Error('Sign in before enrolling.');
      if(!navigator.credentials?.create)throw Error('This browser cannot enroll passkeys.');
      // Only the isolated Owner test page has this optional one-time field.
      // Existing passkey clients remain unchanged when the field is absent.
      const bootstrapField=byId('bootstrapKey');
      const bootstrapValue=bootstrapField?.value.trim()||'';
      if(bootstrapField&&!/^[A-Za-z0-9_-]{43,256}$/.test(bootstrapValue))
        throw Error('Enter the independent Railway Owner bootstrap key.');
      const bootstrapHeaders=bootstrapField?
        {'X-HC-Owner-Bootstrap-Key':bootstrapValue}:{};
      const {challengeId,options}=await send('/staff-passkey/registration/options',{},bootstrapHeaders);
      const publicKey=registrationOptions(options);
      const credential=await navigator.credentials.create({publicKey});
      if(!credential)throw Error('Passkey creation was cancelled.');
      const saved=await send('/staff-passkey/registration/verify',{
        challengeId,response:wrapRegistration(credential)
      },bootstrapHeaders);
      if(saved.registered!==true)throw Error('Passkey registration was not confirmed.');
      if(bootstrapField)bootstrapField.value='';
      show('Passkey registered. Verify it to activate manager security operations.');
    });
  });
  byId('verifyPasskey').addEventListener('click',()=>{
    run(async()=>{
      if(!baseToken)throw Error('Sign in before verifying a passkey.');
      if(!navigator.credentials?.get)throw Error('This browser cannot verify passkeys.');
      clearProof();
      const {challengeId,options}=await send('/staff-passkey/authentication/options',{});
      const publicKey=authenticationOptions(options);
      const credential=await navigator.credentials.get({publicKey});
      if(!credential)throw Error('Passkey verification was cancelled.');
      const result=await send('/staff-passkey/authentication/verify',{
        challengeId,response:wrapAuthentication(credential)
      });
      if(typeof result.token!=='string'||result.token.length>2500||
         !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(result.token)||
         !Number.isSafeInteger(result.expiresIn)||result.expiresIn<1||
         result.expiresIn>300)throw Error('Passkey proof was not valid.');
      proofToken=result.token;
      proofExpires=Date.now()+result.expiresIn*1000;
      byId('proof').textContent = 'Verified (five minutes maximum)';
      show('Passkey verified. Manager operations still require your exact permission.');
    });
  });
  byId('managerApproval').addEventListener('click',()=>{
    run(async()=>{
      if(!proofToken||Date.now()>=proofExpires)throw Error('Verify your passkey again.');
      const requestId=byId('requestId').value.trim();
      if(!/^[a-f0-9-]{36}$/i.test(requestId))throw Error('Enter the employee enrollment request ID.');
      const result=await send('/staff-security/api/enrollment-approve',{
        requestId
      },{'X-HC-Passkey-Proof':proofToken});
      if(result.approved!==true)throw Error('Manager approval was not granted.');
      show('Enrollment approved for this request. Employee may complete authenticator setup.');
    });
  });
  byId('signout').addEventListener('click',()=>{
    baseToken=null;clearProof();
    byId('pin').value='';
    if(byId('bootstrapKey'))byId('bootstrapKey').value='';
    byId('identity').textContent='Not signed in';
    show('Signed out. Local verification data cleared.');refresh();
  });
  document.addEventListener('visibilitychange',()=>{
    // A browser may hide during native credential prompts. Preserve the base
    // session in memory so the ceremony can complete, but clear step-up proof.
    if(document.hidden){clearProof();refresh();}
  });
  window.addEventListener('pagehide',()=>{
    baseToken=null;clearProof();byId('pin').value='';byId('requestId').value='';
    if(byId('bootstrapKey'))byId('bootstrapKey').value='';
  });
  refresh();
})();