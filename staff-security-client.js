(() => {
  'use strict';
  // UI candidate only. No factor data, setup keys or OTPs persist to storage.
  const $ = id => document.getElementById(id);
  const auth = () => window.HCStaffAuth;
  let enrollmentVisible = false;
  let enrollmentExpiresAt = 0;
  let approvalState = 'none';
  let mfaToken = null;
  let mfaExpiresAt = 0;
  let working = false;
  let invitationToken = null;
  // Invite fragment is not sent to servers in HTTP requests. Remove it
  // from the address bar and keep it only in memory until redeemed.
  try {
    const fragment = String(window.location?.hash || '');
    const match = /^#invite=([A-Za-z0-9_-]{43})$/.exec(fragment);
    if (match) invitationToken = match[1];
    if (fragment.startsWith('#invite=')) {
      window.history?.replaceState?.(null, '', window.location.pathname + window.location.search);
    }
  } catch { invitationToken = null; }
  function notice(message) {
    const el = $('notice');
    el.textContent = message;
    el.hidden = !message;
  }
  function discardMfa() {
    mfaToken = null;
    mfaExpiresAt = 0;
    $('mfaCode').value = '';
    $('mfaState').textContent = 'Not verified';
    $('checkMfaStatus').disabled = true;
    $('mfaStatusMessage').textContent = 'No active verification. Enter a fresh code to verify this session.';
  }
  function discardEnrollment() {
    enrollmentVisible = false;
    enrollmentExpiresAt = 0;
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
    $('checkEmployeeSession').disabled = !yes;
    $('checkAllSessions').disabled = !yes;
    $('employeeSessionMessage').textContent = yes
      ? 'Employee session signed in. Use Check employee session to confirm with the server.'
      : 'Not signed in. Sign in with your staging PIN to start another session test.';
    $('startEnrollment').disabled = true;
    $('requestApproval').disabled = !yes;
    $('approveSelfPasskey').disabled = !yes || approvalState !== 'requested';
    $('checkApproval').disabled = !yes;
    $('mfaButton').disabled = true;
    if (!yes) {
      discardMfa();
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
    const response = await fetch('/staff-security/api/' + endpoint, {
      method: options.method || 'GET', cache: 'no-store', mode: 'same-origin',
      credentials: 'omit',
      headers: {
        Authorization: 'Bearer ' + session.token,
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(options.extraHeaders || {})
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Error(safeMessage(response.status, data));
    return data;
  }
  async function redeemInvitation() {
    if (!invitationToken) return false;
    const session = auth()?.readSession?.();
    if (!session?.token) return false;
    const token = invitationToken;
    const response = await fetch('/staff-enrollment-invites/redeem', {
      method:'POST',mode:'same-origin',cache:'no-store',credentials:'omit',
      headers:{
        'Authorization':'Bearer '+session.token,
        'Content-Type':'application/json'
      },
      body:JSON.stringify({token})
    });
    const data=await response.json().catch(()=>({}));
    if(!response.ok) {
      if(response.status===403 || response.status===409)invitationToken=null;
      throw Error(response.status===403
        ? 'This invitation is expired or belongs to a different employee.'
        :response.status===409?'This invitation was already used.':
        'Invitation service unavailable.');
    }
    invitationToken=null;
    applyApproval(data);
    notice('Administrator invitation accepted. Awaiting independently verified manager approval.');
    return true;
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
    $('approveSelfPasskey').disabled = state !== 'requested' || working;
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
  // Existing registered Owner passkey approves THIS account's enrollment.
  // The backend verifies the same signed employee session, current Owner role,
  // fresh signed passkey proof and exact enrollment-request ID. A PIN-only
  // session or browser role never grants approval.
  const ownerBytes = value => {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value))
      throw Error('Invalid passkey challenge.');
    const raw = atob(value.replace(/-/g, '+').replace(/_/g, '/')
      .padEnd(Math.ceil(value.length / 4) * 4, '='));
    return Uint8Array.from(raw, char => char.charCodeAt(0));
  };
  const ownerB64 = value => {
    let text = '';
    for (const byte of new Uint8Array(value)) text += String.fromCharCode(byte);
    return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  };
  async function freshOwnerPasskey() {
    const session = auth()?.readSession?.();
    if (!session?.token || !navigator.credentials?.get)
      throw Error('Sign in on a passkey-capable device.');
    const signed = async (path, data) => {
      const response = await fetch('/staff-passkey/' + path, {
        method:'POST',mode:'same-origin',credentials:'omit',cache:'no-store',
        referrerPolicy:'no-referrer',
        headers:{'Authorization':'Bearer ' + session.token,
          'Content-Type':'application/json'},
        body:JSON.stringify(data)
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) throw Error('A registered Owner passkey is required.');
      return json;
    };
    const ceremony = await signed('authentication/options', {});
    const opts = ceremony.options;
    if (!opts?.challenge || typeof ceremony.challengeId !== 'string')
      throw Error('Passkey ceremony unavailable.');
    const credential = await navigator.credentials.get({publicKey:{
      ...opts,challenge:ownerBytes(opts.challenge),
      allowCredentials:(opts.allowCredentials || []).map(item=>({
        ...item,id:ownerBytes(item.id)
      }))
    }});
    if (!credential) throw Error('Passkey verification was cancelled.');
    const result = await signed('authentication/verify', {
      challengeId:ceremony.challengeId,
      response:{
        id:credential.id,rawId:ownerB64(credential.rawId),type:credential.type,
        response:{
          clientDataJSON:ownerB64(credential.response.clientDataJSON),
          authenticatorData:ownerB64(credential.response.authenticatorData),
          signature:ownerB64(credential.response.signature),
          userHandle:credential.response.userHandle
            ?ownerB64(credential.response.userHandle):null
        },
        clientExtensionResults:credential.getClientExtensionResults()
      }
    });
    if(typeof result.token!=='string'||result.token.length>2500||
       !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(result.token)||
       !Number.isSafeInteger(result.expiresIn)||result.expiresIn<1||
       result.expiresIn>300)
      throw Error('Strong Owner passkey proof was not valid.');
    return result.token;
  }
  async function approveOwnEnrollmentWithPasskey() {
    if (working || approvalState !== 'requested') return;
    working = true;
    $('approveSelfPasskey').disabled = true;
    try {
      const requestId = $('approvalRequestId').value;
      if (!/^[a-f0-9-]{36}$/i.test(requestId))
        throw Error('Refresh the current enrollment request.');
      const proof = await freshOwnerPasskey();
      const result = await request('enrollment-approve', {
        method:'POST',body:{requestId},
        extraHeaders:{'X-HC-Passkey-Proof':proof}
      });
      if(result.approved !== true)throw Error('Owner approval was not confirmed.');
      await loadApproval();
      notice('Owner passkey approved this enrollment. Set up Google Authenticator next.');
    } catch(error) {notice(error.message);}
    finally {working=false;$('approveSelfPasskey').disabled=approvalState!=='requested';}
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
        $('mfaButton').disabled = false;
        $('authHelp').textContent = 'Your authenticator is enabled. Contact a manager if you need to change or recover it.';
        discardEnrollment();
      } else if (result.state === 'pending') {
        $('authState').textContent = 'Setup in progress';
        $('mfaButton').disabled = true;
        $('startEnrollment').disabled = true;
        $('authHelp').textContent = 'An earlier setup was started. You can confirm its code, or restart with a new setup key.';
        $('confirmForm').hidden = false;
      } else if (result.state === 'not_enrolled') {
        $('authState').textContent = 'Not enrolled';
        $('mfaButton').disabled = true;
        $('startEnrollment').disabled = approval.state !== 'approved';
        $('authHelp').textContent = 'Start setup when your registered workstation or approved enrollment verification is available.';
        discardEnrollment();
      } else {
        throw Error('Authenticator status was not recognized.');
      }
      notice('');
    } catch (error) {
      $('authState').textContent = 'Verification needed';
      $('mfaButton').disabled = true;
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
      enrollmentExpiresAt = Number.isSafeInteger(result.expiresAtMs) ? result.expiresAtMs : Date.now() + 600000;
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
      $('mfaButton').disabled = false;
      $('authHelp').textContent = 'Your authenticator is enabled. Keep a backup access method and contact a manager to reset or recover it.';
      $('startEnrollment').disabled = true;
      approvalState = 'none';
      $('approvalState').textContent = 'Completed';
      $('approvalCodeBox').hidden = true;
      notice('Authenticator enabled successfully.');
    } catch (error) { notice(error.message); }
    finally { $('otpCode').value = ''; $('confirmButton').disabled = false; working = false; }
  }
  async function verifyMfa(event) {
    event.preventDefault();
    if (working) return;
    const code = $('mfaCode').value.trim();
    $('mfaCode').value = '';
    if (!/^\d{6}$/.test(code)) {
      notice('Enter a valid six-digit authenticator code.');
      return;
    }
    working = true;
    $('mfaButton').disabled = true;
    discardMfa();
    try {
      const result = await request('mfa/session', { method:'POST', body:{code} });
      if (typeof result.token !== 'string' || result.token.length > 1400 ||
          !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(result.token) ||
          !Number.isSafeInteger(result.expiresIn) ||
          result.expiresIn <= 0 || result.expiresIn > 300) {
        throw Error('Secure verification could not be established.');
      }
      // Never write a second-factor token into localStorage/sessionStorage.
      // Future tool consumers must present both the base session and this
      // ephemeral signed proof, verified on each backend operation.
      mfaToken = result.token;
      mfaExpiresAt = Date.now() + result.expiresIn * 1000;
      $('mfaState').textContent = 'Verified';
      $('checkMfaStatus').disabled = false;
      $('mfaStatusMessage').textContent = 'Verification accepted. You can check its current server status.';
      $('mfaHelp').textContent =
        'Additional verification active for up to ' + Math.ceil(result.expiresIn / 60) +
        ' minutes, ending sooner if your employee session is signed out.';
      notice('Authenticator accepted for this session.');
    } catch (error) { notice(error.message); }
    finally { working = false; $('mfaButton').disabled = false; }
  }
  async function checkEmployeeStatus() {
    if (working) return false;
    const session = auth()?.readSession?.();
    if (!session?.token) {
      setSignedIn(null);
      return false;
    }
    working = true;
    $('checkEmployeeSession').disabled = true;
    $('checkAllSessions').disabled = true;
    try {
      const response = await fetch('/api/staff-auth/session', {
        method:'GET',cache:'no-store',mode:'same-origin',credentials:'omit',
        headers:{Authorization:'Bearer '+session.token}
      });
      if (response.status === 401 || response.status === 403) {
        auth()?.signOut?.();
        setSignedIn(null);
        $('sessionState').textContent = 'Expired';
        $('employeeSessionMessage').textContent =
          'Employee session expired or revoked. Sign in again with the staging PIN.';
        return false;
      }
      if (!response.ok) throw Error('Employee session status could not be checked. Try again.');
      const result = await response.json();
      if (result?.ok !== true ||
          String(result?.employee?.id) !== String(session.employee?.id) ||
          result?.employee?.permissionSource !== session.employee?.permissionSource) {
        auth()?.signOut?.();
        setSignedIn(null);
        $('sessionState').textContent = 'Not verified';
        $('employeeSessionMessage').textContent =
          'Employee identity did not match. Sign in again.';
        return false;
      }
      if (auth()?.readSession?.()?.token !== session.token) {
        $('employeeSessionMessage').textContent = 'Employee session changed. Check again.';
        return false;
      }
      $('sessionState').textContent = 'Active';
      $('employeeSessionMessage').textContent =
        'Server confirmed the employee session is active. Status checking does not extend its expiry.';
      return true;
    } catch (error) {
      $('employeeSessionMessage').textContent = error.message;
      return false;
    } finally {
      working = false;
      const signedIn = Boolean(auth()?.readSession?.()?.token);
      $('checkEmployeeSession').disabled = !signedIn;
      $('checkAllSessions').disabled = !signedIn;
    }
  }
  async function checkAllStatuses() {
    if (working) return;
    const active = await checkEmployeeStatus();
    if (!active) return;
    if (mfaToken) await checkMfaStatus();
    else {
      $('mfaState').textContent = 'Not verified';
      $('mfaStatusMessage').textContent =
        'No active Authenticator proof. Enter a fresh code to test this status.';
    }
  }
  async function checkMfaStatus() {
    if (working) return;
    if (!mfaToken) {
      $('mfaState').textContent = 'Not verified';
      $('mfaStatusMessage').textContent = 'No active verification. Enter a fresh code to verify this session.';
      return;
    }
    // The local expiry is a fast fail-safe, never an authorization decision.
    // The server must independently verify this exact signed proof.
    if (Date.now() >= mfaExpiresAt) {
      discardMfa();
      $('mfaState').textContent = 'Expired';
      $('mfaStatusMessage').textContent = 'Verification expired — verify again with a new code.';
      return;
    }
    working = true;
    $('checkMfaStatus').disabled = true;
    try {
      const session = auth()?.readSession?.();
      if (!session?.token) {
        discardMfa();
        $('mfaStatusMessage').textContent = 'Employee session is unavailable. Sign in and verify again.';
        return;
      }
      const response = await fetch('/staff-security/api/mfa/session', {
        method: 'GET', cache: 'no-store', mode: 'same-origin', credentials: 'omit',
        headers: {
          Authorization: 'Bearer ' + session.token,
          'x-hc-mfa-session': mfaToken
        }
      });
      if (response.status === 401) {
        discardMfa();
        $('mfaState').textContent = 'Expired';
        $('mfaStatusMessage').textContent = 'Verification expired or revoked — verify again with a new code.';
        return;
      }
      if (!response.ok) throw Error('Could not check verification status. Try again.');
      const result = await response.json();
      if (result?.verified !== true || result?.method !== 'totp') {
        discardMfa();
        throw Error('Verification status was not recognized. Verify again.');
      }
      if (Date.now() >= mfaExpiresAt) {
        discardMfa();
        $('mfaState').textContent = 'Expired';
        $('mfaStatusMessage').textContent = 'Verification expired — verify again with a new code.';
        return;
      }
      $('mfaState').textContent = 'Verified';
      $('mfaStatusMessage').textContent = 'Server confirmed this verification is still active.';
    } catch (error) {
      $('mfaStatusMessage').textContent = error.message;
    } finally {
      working = false;
      $('checkMfaStatus').disabled = !mfaToken;
    }
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
      await redeemInvitation();
      await refresh();
    } catch (error) { notice(error.message); }
  });
  $('signOut').addEventListener('click', () => {
    auth()?.signOut?.();
    setSignedIn(null);
    notice('Signed out. Your setup key has been cleared from this page.');
  });
  $('requestApproval').addEventListener('click', requestApproval);
  $('approveSelfPasskey').addEventListener('click', approveOwnEnrollmentWithPasskey);
  $('checkApproval').addEventListener('click', async () => {
    if (working) return;
    try { await loadApproval(); notice('Enrollment approval status updated.'); }
    catch (error) { notice(error.message); }
  });
  $('startEnrollment').addEventListener('click', startEnrollment);
  $('refreshStatus').addEventListener('click', refresh);
  $('confirmForm').addEventListener('submit', confirmEnrollment);
  $('mfaForm').addEventListener('submit', verifyMfa);
  $('checkEmployeeSession').addEventListener('click', checkEmployeeStatus);
  $('checkAllSessions').addEventListener('click', checkAllStatuses);
  $('checkMfaStatus').addEventListener('click', checkMfaStatus);
  $('copyKey').addEventListener('click', async () => {
    if (!enrollmentVisible || !$('setupKey').value) return;
    try {
      await navigator.clipboard.writeText($('setupKey').value);
      notice('Setup key copied. Clear your clipboard after adding the authenticator.');
    } catch { notice('Copy is unavailable. Enter the setup key manually.'); }
  });
  document.addEventListener('visibilitychange', () => {
    // Employees may temporarily switch to Google Authenticator on the SAME
    // phone. Retain the pending QR only in this tab's memory for its short
    // enrollment window; never persist to localStorage/sessionStorage.
    if (document.hidden) discardMfa();
    else if (enrollmentVisible && Date.now() >= enrollmentExpiresAt) {
      discardEnrollment();
      notice('Authenticator setup expired. Request a fresh approved enrollment.');
    }
  });
  window.addEventListener('pagehide', () => { discardEnrollment(); discardMfa(); });
  if (auth()?.verify) {
    auth().verify().then(session => {
      setSignedIn(session);
      if (session?.token) redeemInvitation().then(() => refresh())
        .catch(error => notice(error.message));
    }).catch(() => setSignedIn(null));
  } else {
    setSignedIn(null);
    notice('Staff sign-in is not connected in this development preview.');
  }
})();
