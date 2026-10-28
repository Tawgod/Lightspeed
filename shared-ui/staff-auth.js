(() => {
  const SESSION_KEY='hcStaffSessionV1';
  const LEGACY_KEY='hcSpecialOrdersKey';

  function readSession(){
    try{
      const raw=sessionStorage.getItem(SESSION_KEY);
      if(!raw)return null;
      const data=JSON.parse(raw);
      if(!data?.token||!Number.isFinite(data.expiresAt)||data.expiresAt<=Date.now()){
        sessionStorage.removeItem(SESSION_KEY);
        return null;
      }
      return data;
    }catch{
      sessionStorage.removeItem(SESSION_KEY);
      return null;
    }
  }

  function employee(){return readSession()?.employee||null}

  function headers(extra={}){
    const session=readSession();
    if(session?.token)return {...extra,Authorization:'Bearer '+session.token};
    const legacy=String(sessionStorage.getItem(LEGACY_KEY)||'').trim();
    return legacy?{...extra,'x-hobby-corner-key':legacy}:{...extra};
  }

  async function signIn(pin){
    const clean=String(pin||'').trim();
    if(!/^\d{4}$/.test(clean))throw new Error('Enter your 4-digit Timeclock PIN.');

    const response=await fetch('/api/staff-auth/session',{
      method:'POST',
      cache:'no-store',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({pin:clean})
    });
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(
      response.status===429
        ? 'Too many sign-in attempts. Try again later.'
        : data.error||'Timeclock PIN was not accepted.'
    );
    if(!data?.token||!Number.isFinite(data.expiresIn)||data.expiresIn<=0){
      throw new Error('Employee sign-in returned an invalid session.');
    }

    const session={
      token:data.token,
      expiresAt:Date.now()+data.expiresIn*1000,
      employee:data.employee||null
    };
    sessionStorage.setItem(SESSION_KEY,JSON.stringify(session));
    sessionStorage.removeItem(LEGACY_KEY);
    return session;
  }

  async function verify(){
    const session=readSession();
    if(!session)return null;
    const response=await fetch('/api/staff-auth/session',{
      cache:'no-store',
      headers:headers()
    });
    if(!response.ok){
      sessionStorage.removeItem(SESSION_KEY);
      return null;
    }
    const data=await response.json().catch(()=>({}));
    if(data.employee){
      session.employee=data.employee;
      sessionStorage.setItem(SESSION_KEY,JSON.stringify(session));
    }
    return session;
  }

  function signOut(){
    sessionStorage.removeItem(SESSION_KEY);
  }

  function setLegacyKey(value){
    const clean=String(value||'').trim();
    if(clean)sessionStorage.setItem(LEGACY_KEY,clean);
    else sessionStorage.removeItem(LEGACY_KEY);
    sessionStorage.removeItem(SESSION_KEY);
  }

  function legacyKey(){return String(sessionStorage.getItem(LEGACY_KEY)||'')}

  window.HCStaffAuth={
    readSession,
    employee,
    headers,
    signIn,
    verify,
    signOut,
    setLegacyKey,
    legacyKey
  };
})();
