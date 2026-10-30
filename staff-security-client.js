(() => {
  'use strict';
  // UI candidate only. No factor data, setup keys or OTPs persist to storage.
  const $ = id => document.getElementById(id);
  const auth = () => window.HCStaffAuth;
  let enrollmentVisible = false;
  let approvalState = 'none';
  let working = false;
  function notice(message) {
    const el = $('notice');
    el.textContent = message;
    el.hidden = !message;
  }
  function discardEnrollment() {
    enrollmentVisible = false;
    $('enrollView').hidden = true;
    $('qrImage').removeAttribute('src');
    $('qrImage').hidden = true;
    $('qrUnavailable').hidden = true;
    $('setupKey').value = '';
    $('expiry').textContent = '';
    $('otpCode').value = '';
    $('confirmForm').hidden = true;
  }
  function setSignedIn(session) {
    const yes = Boolean(session?.token && session.employee?.id);
    $('signInForm').hidden = yes;
    $('signedInRow').hidden = !yes;
    $('sessionState').textContent = yes ? 'Signed in' : 'Not signed in';
    $('employeeName').textContent = yes
      ? 'Signed in as ' + String(session.employee.name || 'employee') : '';
    $('refreshStatus').disabled = !yes;
    $('startEnrollment').disabled = true;
    $('requestApproval').disabled = !yes;
    $('checkApproval').disabled = !yes;
    if (!yes) {
      approvalState = 'none';
      $('approvalState').textContent = 'Not requested';
      $('approvalCodeBox').hidden = true;
      $('approvalRequestId').value = '';
      $('authState').textContent = 'Not checked';
      $('authHelp').textContent = 'Sign in to check whether an authenticator is enrolled.';
      discardEnrollment();
    }
  }
  function safeMessage(status, body) {
    if (status === 403) return 'Additional verified device or manager-approved enrollment is required. PIN sign-in alone cannot change security settings.';
    if (status === 401) return 'Your session or code was not accepted. Please sign in or try a new six-digit code.';
    if (status === 409) return 'An enrollment request is already in progress.';
    if (status === 429) return 'Too many attempts. Please try again later.';
    return String(body?.error || 'Employee security settings are unavailable.');
  }
  async function request(endpoint, options = {}) {
    const session = auth()?.readSession?.();
    if (!session?.token) throw Error('Sign in with your Timeclock PIN first.');
    const response = await fetch('./api/' + endpoint, {
      method: options.method || 'GET', cache: 'no-store', mode: 'same-origin',
      credentials: 'omit',
      headers: {
        Authorization: 'Bearer ' + session.token,
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Error(safeMessage(response.status, data));
    return data;
  }
  function applyApproval(data) {
    const state = ['none', 'requested', 'approved', 'started'].includes(data?.state)
      ? data.state : 'none';
    approvalState = state;
    $('approvalState').textContent = ({
      none: 'Not requested', requested: 'Awaiting manager',
      approved: 'Approved', started: 'Enrollment started'
    })[state];
    const hasId = state !== 'none' && typeof data.requestId === 'string';
    $('approvalCodeBox').hidden = !hasId;
    $('approvalRequestId').value = hasId ? data.requestId : '';
    $('approvalExpiration').textContent = Number.isSafeInteger(data?.expiresAtMs)
      ? 'Expires at ' + new Date(data.expiresAtMs).toLocaleTimeString() + '.'
      : '';
    $('requestApproval').disabled = state !== 'none' || working;
    $('startEnrollment').disabled = state !== 'approved' || working;
    if (state === 'requested') $('authHelp').textContent =
      'Your setup request is awaiting independently verified manager approval.';
  }
  async function loadApproval() {
    const result = await request('enrollment-request');
    applyApproval(result);
    return result;
  }
  async function requestApproval() {
    if (working) return;
    working = true;
    $('requestApproval').disabled = true;
    try {
      const data = await request('enrollment-request', { method: 'POST', body: {} });
      applyApproval(data);
      notice('Request created. Share the request ID with an authorized manager.');
    } catch (error) {
      notice(error.message);
      $('requestApproval').disabled = false;
    } finally { working = false; }
  }
  async function refresh() {
    if (working) return;
    working = true;
    try {
      const approval = await loadApproval();
      const result = await request('authenticator');
      if (result.state === 'active') {
        $('authState').textContent = 'Enabled';
        $('startEnrollment').disabled = true;
        $('authHelp').textContent = 'Your authenticator is enabled. Contact a manager if you need to change or recover it.';
        discardEnrollment();
      } else if (result.state === 'pending') {
        $('authState').textContent = 'Setup in progress';
        $('startEnrollment').disabled = true;
        $('authHelp').textContent = 'An earlier setup was started. You can confirm its code, or restart with a new setup key.';
        $('confirmForm').hidden = false;
      } else if (result.state === 'not_enrolled') {
        $('authState').textContent = 'Not enrolled';
        $('startEnrollment').disabled = approval.state !== 'approved';
        $('authHelp').textContent = 'Start setup when your registered workstation or approved enrollment verification is available.';
        discardEnrollment();
      } else {
        throw Error('Authenticator status was not recognized.');
      }
      notice('');
    } catch (error) {
      $('authState').textContent = 'Verification needed';
      $('startEnrollment').disabled = true;
      notice(error.message);
    } finally { working = false; }
  }
  async function startEnrollment() {
    if (working) return;
    if (approvalState !== 'approved') {
      notice('A separately verified manager approval is required before generating a setup key.');
      return;
    }
    working = true;
    $('startEnrollment').disabled = true;
    discardEnrollment();
    try {
      const result = await request('authenticator/enroll', { method: 'POST', body: {} });
      if (!/^[A-Z2-7]{32}$/.test(result.manualKey || '')) throw Error('Setup could not be displayed securely.');
      $('setupKey').value = result.manualKey;
      if (typeof result.qrDataUrl === 'string' &&
          /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(result.qrDataUrl) &&
          result.qrDataUrl.length < 250000) {
        $('qrImage').src = result.qrDataUrl;
        $('qrImage').hidden = false;
      } else {
        $('qrUnavailable').hidden = false;
      }
      $('expiry').textContent = Number.isSafeInteger(result.expiresAtMs)
        ? 'Setup expires at ' + new Date(result.expiresAtMs).toLocaleTimeString() + '.'
        : 'Setup expires after 10 minutes.';
      $('enrollView').hidden = false;
      $('confirmForm').hidden = false;
      $('authState').textContent = 'Awaiting confirmation';
      $('authHelp').textContent = 'Enter your next six-digit authenticator code to activate this method.';
      enrollmentVisible = true;
      approvalState = 'started';
      $('approvalState').textContent = 'Enrollment started';
      notice('');
    } catch (error) { notice(error.message); }
    finally { working = false; $('startEnrollment').disabled = false; }
  }
  async function confirmEnrollment(event) {
    event.preventDefault();
    if (working) return;
    const code = $('otpCode').value.trim();
    if (!/^\d{6}$/.test(code)) { notice('Enter the six-digit code shown in your authenticator.'); return; }
    working = true;
    $('confirmButton').disabled = true;
    try {
      const result = await request('authenticator/confirm', { method: 'POST', body: { code } });
      if (result.confirmed !== true) throw Error('Authenticator confirmation was not completed.');
      discardEnrollment();
      $('authState').textContent = 'Enabled';
      $('authHelp').textContent = 'Your authenticator is enabled. Keep a backup access method and contact a manager to reset or recover it.';
      $('startEnrollment').disabled = true;
      approvalState = 'none';
      $('approvalState').textContent = 'Completed';
      $('approvalCodeBox').hidden = true;
      notice('Authenticator enabled successfully.');
    } catch (error) { notice(error.message); }
    finally { $('otpCode').value = ''; $('confirmButton').disabled = false; working = false; }
  }
  $('signInForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (working) return;
    const pin = $('employeePin').value;
    $('employeePin').value = '';
    try {
      const session = await auth()?.signIn?.(pin);
      if (!session?.token) throw Error('Staff sign-in is not available.');
      setSignedIn(session);
      await refresh();
    } catch (error) { notice(error.message); }
  });
  $('signOut').addEventListener('click', () => {
    auth()?.signOut?.();
    setSignedIn(null);
    notice('Signed out. Your setup key has been cleared from this page.');
  });
  $('requestApproval').addEventListener('click', requestApproval);
  $('checkApproval').addEventListener('click', async () => {
    if (working) return;
    try { await loadApproval(); notice('Enrollment approval status updated.'); }
    catch (error) { notice(error.message); }
  });
  $('startEnrollment').addEventListener('click', startEnrollment);
  $('refreshStatus').addEventListener('click', refresh);
  $('confirmForm').addEventListener('submit', confirmEnrollment);
  $('copyKey').addEventListener('click', async () => {
    if (!enrollmentVisible || !$('setupKey').value) return;
    try {
      await navigator.clipboard.writeText($('setupKey').value);
      notice('Setup key copied. Clear your clipboard after adding the authenticator.');
    } catch { notice('Copy is unavailable. Enter the setup key manually.'); }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) discardEnrollment();
  });
  window.addEventListener('pagehide', discardEnrollment);
  if (auth()?.verify) {
    auth().verify().then(session => {
      setSignedIn(session);
      if (session?.token) refresh();
    }).catch(() => setSignedIn(null));
  } else {
    setSignedIn(null);
    notice('Staff sign-in is not connected in this development preview.');
  }
})();
