export function normalizePublicBasePath(value = '') {
  const raw = String(value ?? '').trim();
  if (!raw || raw === '/') return '';

  if (!raw.startsWith('/')) {
    throw new Error('HC_PUBLIC_BASE_PATH must start with "/".');
  }
  if (/[?#\\\\]/.test(raw)) {
    throw new Error('HC_PUBLIC_BASE_PATH must be a URL path only.');
  }

  const normalized = raw.replace(/\/+$/, '');
  if (normalized.includes('//')) {
    throw new Error('HC_PUBLIC_BASE_PATH cannot contain empty path segments.');
  }

  for (const segment of normalized.slice(1).split('/')) {
    if (!segment || segment === '.' || segment === '..' || !/^[A-Za-z0-9._~-]+$/.test(segment)) {
      throw new Error('HC_PUBLIC_BASE_PATH contains an invalid path segment.');
    }
  }

  return normalized;
}

export function stripPublicBasePath(url, basePath) {
  const base = normalizePublicBasePath(basePath);
  const raw = String(url || '/');
  if (!base) return raw;

  const queryIndex = raw.indexOf('?');
  const pathname = queryIndex >= 0 ? raw.slice(0, queryIndex) : raw;
  const suffix = queryIndex >= 0 ? raw.slice(queryIndex) : '';

  if (pathname === base) return '/' + suffix;
  if (pathname.startsWith(base + '/')) return pathname.slice(base.length) + suffix;
  return raw;
}

export function publicUrl(basePath, route = '/') {
  const base = normalizePublicBasePath(basePath);
  const rawRoute = String(route || '/');
  const routePath = rawRoute.startsWith('/') ? rawRoute : '/' + rawRoute;
  return base + routePath;
}

export function normalizePublicLandingPath(value = '') {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (/[?#\\\\]/.test(raw)) {
    throw new Error('HC_PUBLIC_LANDING_PATH must be a URL path only.');
  }
  const withoutSlashes = raw.replace(/^\/+|\/+$/g, '');
  if (!withoutSlashes) return '';
  for (const segment of withoutSlashes.split('/')) {
    if (!segment || segment === '.' || segment === '..' || !/^[A-Za-z0-9._~-]+$/.test(segment)) {
      throw new Error('HC_PUBLIC_LANDING_PATH contains an invalid path segment.');
    }
  }
  return '/' + withoutSlashes;
}

export function createPublicBasePathMiddleware(basePath) {
  const base = normalizePublicBasePath(basePath);

  return function publicBasePathMiddleware(req, res, next) {
    const originalUrl = String(req.url || '/');
    const strippedUrl = stripPublicBasePath(originalUrl, base);

    req.hcPublicBasePath = base;
    req.hcPublicPathMatched = Boolean(base && strippedUrl !== originalUrl);
    if (res?.locals) res.locals.publicBasePath = base;
    req.url = strippedUrl;
    next();
  };
}
