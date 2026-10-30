import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// RFC 6238 / RFC 4226 compatible, unmounted candidate.
// Standard 6-digit 30-second SHA-1 TOTP works with Google Authenticator
// and other standards-compliant authenticator applications.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_MS = 30_000;
const SECRET_BYTES = 20;
const MAX_SKEW = 1;

function base32Encode(bytes) {
  let bits = 0, value = 0, result = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      result += ALPHABET[(value >>> (bits -= 5)) & 31];
    }
  }
  if (bits) result += ALPHABET[(value << (5 - bits)) & 31];
  return result;
}
function base32Decode(secret) {
  if (typeof secret !== 'string' || !/^[A-Z2-7]{32}$/.test(secret)) {
    throw new TypeError('Invalid authenticator secret.');
  }
  let value = 0, bits = 0;
  const bytes = [];
  for (const ch of secret) {
    value = (value << 5) | ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits -= 8)) & 255);
      value &= (1 << bits) - 1;
    }
  }
  if (bytes.length !== SECRET_BYTES) throw new TypeError('Invalid authenticator secret length.');
  return Buffer.from(bytes);
}

export function generateStaffTotpSecret() {
  return base32Encode(randomBytes(SECRET_BYTES));
}

export function createStaffTotpProvisioningUri({ secret, employeeId, issuer = 'Hobby Corner' } = {}) {
  base32Decode(secret); // Never embed arbitrary data in a provisioning URI.
  if (typeof employeeId !== 'string' || !/^[1-9][0-9]{0,17}$/.test(employeeId) ||
      typeof issuer !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 &-]{2,60}$/.test(issuer)) {
    throw new TypeError('Invalid authenticator enrollment label.');
  }
  const url = new URL('otpauth://totp/' + encodeURIComponent(issuer + ':Employee ' + employeeId));
  url.searchParams.set('secret', secret);
  url.searchParams.set('issuer', issuer);
  url.searchParams.set('algorithm', 'SHA1');
  url.searchParams.set('digits', '6');
  url.searchParams.set('period', '30');
  // The URI is a credential. Show once on a trusted enrollment screen
  // with Cache-Control: no-store; NEVER log, publish or persist it.
  return url.toString();
}

function codeForStep(secretBytes, step) {
  if (!Number.isSafeInteger(step) || step < 0) throw new TypeError('Invalid authenticator counter.');
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(step));
  const hash = createHmac('sha1', secretBytes).update(message).digest();
  const offset = hash.at(-1) & 0xf;
  const value = (hash.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(value).padStart(6, '0');
}

// Pure matching only; a persistent verifier MUST atomically reserve the
// returned step to prevent reuse across requests, servers and time windows.
// Never call this directly as a login grant.
export function matchStaffTotpStep({ secret, code, nowMs = Date.now() } = {}) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code) ||
      !Number.isSafeInteger(nowMs) || nowMs < 0) return null;
  const key = base32Decode(secret);
  const current = Math.floor(nowMs / STEP_MS);
  let matched = null;
  const submitted = Buffer.from(code, 'ascii');
  for (let offset = -MAX_SKEW; offset <= MAX_SKEW; offset++) {
    const step = current + offset;
    if (step < 0) continue;
    const expected = Buffer.from(codeForStep(key, step), 'ascii');
    if (timingSafeEqual(submitted, expected)) matched = matched === null ? step : Math.max(step, matched);
  }
  return matched;
}
