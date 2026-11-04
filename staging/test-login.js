// Staging-only browser test. Keep signed tokens in memory, never in storage or URL.
(() => {
  const form = document.getElementById('test-login');
  const pin = document.getElementById('test-pin');
  const button = document.getElementById('login-button');
  const status = document.getElementById('login-status');
  let signedSession = null;
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const value = pin.value;
    pin.value = '';
    if (!/^\d{4}$/.test(value)) {
      status.textContent = 'Enter your four-digit test PIN.';
      return;
    }
    button.disabled = true;
    status.textContent = 'Checking your test PIN…';
    signedSession = null;
    try {
      const reply = await fetch('/api/staff-auth/session', {
        method: 'POST', cache: 'no-store',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({pin: value})
      });
      if (!reply.ok) {
        status.textContent = reply.status === 429
          ? 'Too many attempts. Try again later.'
          : 'Test sign-in failed. Check your test PIN.';
        return;
      }
      const result = await reply.json();
      if (typeof result.token !== 'string' || result.employee?.permissionSource !== 'synthetic_staging_only')
        throw new Error('Unexpected staging identity');
      signedSession = result.token;
      const verify = await fetch('/api/staff-auth/session', {
        cache: 'no-store', headers: {Authorization: 'Bearer ' + signedSession}
      });
      if (!verify.ok) throw new Error('Could not confirm session');
      const employee = (await verify.json()).employee;
      if (employee?.id !== '901') throw new Error('Unexpected employee');
      status.textContent = 'Signed in as Staging Test Owner. Your test session lasts 15 minutes. Authenticator setup is not enabled yet.';
    } catch {
      signedSession = null;
      status.textContent = 'Sign-in service unavailable. Check the staging service status.';
    } finally {
      button.disabled = false;
    }
  });
})();
