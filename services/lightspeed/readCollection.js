// Strict, bounded read pagination for Lightspeed list responses.
// Never silently interpret incomplete/failed vendor pagination as "no results".
export class LightspeedIncompleteReadError extends Error {
  constructor(message = 'Lightspeed list response incomplete.') {
    super(message);
    this.name = 'LightspeedIncompleteReadError';
    this.code = 'LIGHTSPEED_INCOMPLETE_READ';
    this.status = 502;
  }
}

export function requireLightspeedRows(body) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.data)) return body.data;
  throw new LightspeedIncompleteReadError();
}

function nextPath(body, currentPath) {
  const links = body?.links;
  const next = links?.next ?? body?.pagination?.next ?? body?.next ?? null;
  if (next === null || next === false || next === '') {
    const p = body?.pagination;
    if (p?.has_next === true || p?.hasNext === true) {
      throw new LightspeedIncompleteReadError('Vendor advertises another page without a usable continuation.');
    }
    return null;
  }
  if (typeof next !== 'string' || next.length > 2048) throw new LightspeedIncompleteReadError('Invalid continuation.');
  // Accept a same-origin relative API path or a query-only continuation; reject absolute URLs
  // to prevent vendor response data from redirecting bearer credentials to an arbitrary host.
  if (next.startsWith('?')) return currentPath.split('?')[0] + next;
  if (!next.startsWith('/api/') || next.startsWith('//') || next.includes('..') ||
      /%2f|%5c|[\r\n\\]/i.test(next)) {
    throw new LightspeedIncompleteReadError('Unexpected pagination target.');
  }
  return next;
}

export async function readLightspeedCollection({
  transport, path, maxPages = 10, maxRows = 10000, rejectFullPage = true
} = {}) {
  if (typeof transport?.request !== 'function' || typeof path !== 'string' || !path.startsWith('/api/')) {
    throw new TypeError('Trusted Lightspeed transport and API path required.');
  }
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 50 ||
      !Number.isInteger(maxRows) || maxRows < 1 || maxRows > 50000) throw new RangeError('Invalid read limits.');

  const seenPaths = new Set(), output = [];
  let current = path, page = 0;
  while (current !== null) {
    if (page++ >= maxPages || seenPaths.has(current)) throw new LightspeedIncompleteReadError('Pagination limit or cycle.');
    seenPaths.add(current);
    const body = await transport.request(current);
    const entries = requireLightspeedRows(body);
    if (entries.length + output.length > maxRows) throw new LightspeedIncompleteReadError('Row cap reached.');
    output.push(...entries);
    const next = nextPath(body, current);
    if (!next && rejectFullPage) {
      // When the upstream omits pagination metadata, a completely filled requested page
      // is ambiguous: do not report a potentially truncated list as exhaustive.
      const size = new URL(current, 'https://placeholder.invalid').searchParams.get('page_size');
      if (size && Number.isInteger(Number(size)) && Number(size) > 0 && entries.length >= Number(size)) {
        const pagination = body?.pagination;
        const complete = pagination?.has_next === false || pagination?.hasNext === false ||
          pagination?.next === null || body?.links?.next === null;
        if (!complete) throw new LightspeedIncompleteReadError('Full page without verified end of results.');
      }
    }
    current = next;
  }
  return output;
}
