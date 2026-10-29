// Canonical HTTP transport foundation. Not connected to production callers in Phase 1.
// All callers supply a trusted server-side domain/token; never expose credentials to browsers.
const DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const READ_RETRY_STATUSES = new Set([429, 502, 503, 504]);
const METHOD = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);

export class LightspeedTransportError extends Error {
  constructor(message, { status = 502, code = 'LIGHTSPEED_TRANSPORT', retryable = false, mayHaveWritten = false } = {}) {
    super(message);
    this.name = 'LightspeedTransportError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.mayHaveWritten = mayHaveWritten;
  }
}

export function createLightspeedTransport({
  domain, token, fetchImpl = globalThis.fetch, timeoutMs = 10000, readRetries = 1
} = {}) {
  const store = String(domain || '').trim().toLowerCase();
  if (!DOMAIN.test(store) || !String(token || '').trim()) throw new Error('Valid Lightspeed server configuration required.');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) throw new RangeError('Invalid request timeout.');
  if (!Number.isInteger(readRetries) || readRetries < 0 || readRetries > 3) throw new RangeError('Invalid read retry count.');
  const origin = 'https://' + store + '.retail.lightspeed.app';

  async function request(path, { method = 'GET', body, correlationId } = {}) {
    const verb = String(method).toUpperCase();
    if (!METHOD.has(verb)) throw new TypeError('Unsupported Lightspeed method.');
    if (typeof path !== 'string' || !path.startsWith('/api/') ||
        path.includes('..') || /%2f|%5c|\\|[\r\n]/i.test(path) || path.startsWith('//')) {
      throw new TypeError('Lightspeed path must be a local /api/ path.');
    }
    const url = new URL(path, origin);
    if (url.origin !== origin || !url.pathname.startsWith('/api/')) throw new TypeError('Invalid Lightspeed API target.');
    if (body !== undefined && (verb === 'GET' || verb === 'HEAD')) throw new TypeError('Read request cannot include a body.');
    if (correlationId !== undefined && !/^[A-Za-z0-9_.:-]{1,128}$/.test(String(correlationId))) {
      throw new TypeError('Invalid correlation ID.');
    }
    const isRead = verb === 'GET' || verb === 'HEAD';
    const headers = {
      Authorization: 'Bearer ' + token,
      Accept: 'application/json',
      'User-Agent': 'HobbyCorner-LightspeedGateway/1.0'
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (correlationId) headers['X-Request-ID'] = String(correlationId);

    for (let attempt = 0; attempt <= (isRead ? readRetries : 0); attempt += 1) {
      let response;
      try {
        response = await fetchImpl(url.toString(), {
          method: verb, headers, redirect: 'error', cache: 'no-store',
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(timeoutMs)
        });
      } catch {
        if (isRead && attempt < readRetries) continue;
        throw new LightspeedTransportError('Lightspeed connection unavailable.', {
          code: 'LIGHTSPEED_NETWORK', retryable: isRead, mayHaveWritten: !isRead
        });
      }

      let raw;
      try {
        raw = await response.text();
      } catch {
        throw new LightspeedTransportError('Lightspeed response could not be read.', {
          code: 'LIGHTSPEED_RESPONSE', mayHaveWritten: !isRead
        });
      }
      let data = null;
      if (raw) {
        try { data = JSON.parse(raw); } catch { data = raw; }
      }
      if (!response.ok) {
        const retryable = isRead && READ_RETRY_STATUSES.has(response.status);
        if (retryable && attempt < readRetries) continue;
        throw new LightspeedTransportError('Lightspeed rejected request (' + response.status + ').', {
          status: response.status, code: 'LIGHTSPEED_HTTP', retryable,
          mayHaveWritten: false
        });
      }
      return data;
    }
  }
  return Object.freeze({ request });
}
