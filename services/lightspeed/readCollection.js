// Strict bounded X-Series collection pagination: version-based for collection
// endpoints and offset-based for /search. No credentials follow vendor-provided absolute URLs.
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
const invalid = message => { throw new LightspeedIncompleteReadError(message); };
const parseCursor = value => {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) invalid('Unsafe vendor version cursor.');
  const str = String(value);
  if (!/^\d{1,20}$/.test(str)) invalid('Invalid vendor version cursor.');
  return BigInt(str);
};
function safeNext(next, current) {
  if (typeof next !== 'string' || next.length > 2048) invalid('Invalid continuation.');
  const path = next.startsWith('?') ? current.split('?')[0] + next : next;
  if (!path.startsWith('/api/') || path.startsWith('//') || path.includes('..') ||
      /%2f|%5c|[\r\n\\]/i.test(path)) invalid('Unexpected pagination target.');
  return path;
}
const withParam = (path, key, value) => {
  const url = new URL(path, 'https://placeholder.invalid');
  url.searchParams.set(key, String(value));
  return url.pathname + url.search;
};
const pageSize = path => {
  const val = new URL(path, 'https://placeholder.invalid').searchParams.get('page_size');
  const count = val === null ? 100 : Number(val);
  if (!Number.isInteger(count) || count < 1 || count > 1000) invalid('Invalid requested page size.');
  return count;
};
export async function readLightspeedCollection({
  transport, path, maxPages = 20, maxRows = 20000, pagination = 'auto'
} = {}) {
  if (typeof transport?.request !== 'function' || typeof path !== 'string' || !path.startsWith('/api/')) {
    throw new TypeError('Trusted Lightspeed transport and API path required.');
  }
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 50 ||
      !Number.isInteger(maxRows) || maxRows < 1 || maxRows > 50000 ||
      !['auto', 'offset', 'version', 'single'].includes(pagination)) {
    throw new RangeError('Invalid read limits or pagination strategy.');
  }
  const mode = pagination === 'auto' ? (/\/search\?/.test(path) ? 'offset' : 'version') : pagination;
  const seenPaths = new Set(), result = [];
  let current = path;
  while (current !== null) {
    if (seenPaths.size >= maxPages || seenPaths.has(current)) invalid('Pagination limit or cycle.');
    seenPaths.add(current);
    const body = await transport.request(current);
    const rows = requireLightspeedRows(body);
    if (result.length + rows.length > maxRows) invalid('Read row cap reached.');
    result.push(...rows);
    const hasNext = body?.links?.next ?? body?.pagination?.next ?? body?.next;
    const hasExplicitNext = (typeof hasNext === 'string' && hasNext.length > 0);
    if (hasExplicitNext) {
      current = safeNext(hasNext, current);
      continue;
    }
    if (body?.pagination?.has_next === true || body?.pagination?.hasNext === true) {
      invalid('Next page advertised without usable continuation.');
    }
    if (!rows.length || mode === 'single') { current = null; continue; }
    if (mode === 'offset') {
      // X-Series search uses offset+page_size, not version cursor.
      // A full page is ambiguous: request another offset until short or empty.
      const limit = pageSize(current);
      const offset = Number(new URL(current, 'https://placeholder.invalid').searchParams.get('offset') || '0');
      if (!Number.isSafeInteger(offset) || offset < 0) invalid('Invalid search offset.');
      current = rows.length >= limit ? withParam(current, 'offset', offset + rows.length) : null;
    } else {
      // Date-versioned X-Series collection endpoints use data + version.max.
      // Repeat after=version.max until an empty page confirms exhaustion.
      if (body?.version?.max !== undefined && body.version.max !== null) {
        const cursor = parseCursor(body.version.max);
        const previous = new URL(current, 'https://placeholder.invalid').searchParams.get('after');
        if (previous !== null && cursor <= parseCursor(previous)) invalid('Non-advancing version cursor.');
        current = withParam(current, 'after', cursor.toString());
      } else {
        // Old/read-specific endpoints may lack cursor metadata. A nonfull
        // page can be exhausted; a full page cannot be treated as complete.
        if (rows.length >= pageSize(current)) invalid('Full collection page without version cursor.');
        current = null;
      }
    }
  }
  return result;
}
