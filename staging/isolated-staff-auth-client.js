// Browser adapter for the isolated synthetic employee 901 ONLY.
// Loaded only from the gated staging enrollment composition. Never persists a
// bearer token or PIN to browser storage, URLs, cookies, logs or Discord.
(() => {
  'use strict';
  let current = null;
  const clear = () => { current = null; };
  const valid = data => typeof data?.token === 'string' &&
    data.token.length > 0 && data.token.length <= 2500 &&
    String(data.employee?.id) === '901' &&
    data.employee?.permissionSource === 'synthetic_staging_only';
  async function signIn(pin) {
    clear();
    if (typeof pin !== 'string' || !/^\d{4}$/.test(pin))
      throw Error('Enter your four-digit synthetic staging PIN.');
    const response = await fetch('/api/staff-auth/session', {
      method:'POST',cache:'no-store',mode:'same-origin',credentials:'omit',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({pin})
    });
    if (!response.ok) throw Error(response.status === 429
      ? 'Too many sign-in attempts. Try again later.'
      : 'Staging test sign-in failed.');
    const data = await response.json().catch(()=>null);
    if (!valid(data)) throw Error('Unexpected staging identity; sign-in denied.');
    current = {token:data.token,employee:{
      id:'901',name:String(data.employee.name || 'Staging Test Owner'),
      permissionSource:'synthetic_staging_only'
    }};
    return current;
  }
  async function verify() {
    if (!current?.token) return null;
    try {
      const response=await fetch('/api/staff-auth/session',{
        method:'GET',cache:'no-store',mode:'same-origin',credentials:'omit',
        headers:{'Authorization':'Bearer '+current.token}
      });
      if (!response.ok) {clear();return null;}
      const data=await response.json();
      if (String(data?.employee?.id)!=='901' ||
          data.employee?.permissionSource!=='synthetic_staging_only') {
        clear();return null;
      }
      return current;
    }catch {clear();return null;}
  }
  // No persistence: a refresh requires the test employee to sign in again.
  window.HCStaffAuth=Object.freeze({
    signIn,verify,readSession:()=>current,signOut:clear
  });
  window.addEventListener('pagehide',clear);
})();
