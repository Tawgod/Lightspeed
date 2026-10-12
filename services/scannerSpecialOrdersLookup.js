// Server-side adapter to the existing Special Orders matching endpoints.
// Never expose SPECIAL_ORDERS_ADMIN_KEY or this adapter in browser/extension code.
export function createSpecialOrdersMatchLookup({
  baseUrl, adminKey, fetchImpl = globalThis.fetch, timeoutMs = 6000
} = {}) {
  const root = new URL(baseUrl || 'http://127.0.0.1:8080');
  if (root.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(root.hostname)
      || root.username || root.password || root.pathname !== '/' || root.search || root.hash) {
    throw new Error('Special Orders matching adapter requires a loopback-only HTTP origin.');
  }
  if (!adminKey || typeof adminKey !== 'string') {
    throw new Error('Special Orders backend authentication is not configured.');
  }
  return async function lookup(kind, payload) {
    if (kind !== 'local' && kind !== 'remote') throw new Error('Unknown product lookup type.');
    const path = kind === 'local' ? '/api/special-orders/products/match-local'
                                 : '/api/special-orders/products/match-remote';
    const response = await fetchImpl(new URL(path, root), {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'x-hobby-corner-key': adminKey
      },
      body: JSON.stringify(payload)
    });
    if (!response.ok) throw new Error('Special Orders '+kind+' matching failed ('+response.status+').');
    const result = await response.json();
    if (!result || !Array.isArray(result.matches)) {
      throw new Error('Special Orders '+kind+' matching returned invalid data.');
    }
    return result;
  };
}
