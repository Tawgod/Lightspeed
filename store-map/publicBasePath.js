function normalizePublicBasePath(value = "") {
  const raw = String(value ?? "").trim();
  if (!raw || raw === "/") return "";
  if (!raw.startsWith("/")) throw new Error('HC_PUBLIC_BASE_PATH must start with "/".');
  if (/[?#\\\\]/.test(raw)) throw new Error("HC_PUBLIC_BASE_PATH must be a URL path only.");
  const normalized = raw.replace(/\/+$/, "");
  if (normalized.includes("//")) throw new Error("HC_PUBLIC_BASE_PATH cannot contain empty path segments.");
  for (const segment of normalized.slice(1).split("/")) {
    if (!segment || segment === "." || segment === ".." || !/^[A-Za-z0-9._~-]+$/.test(segment)) {
      throw new Error("HC_PUBLIC_BASE_PATH contains an invalid path segment.");
    }
  }
  return normalized;
}

function stripPublicBasePath(url, basePath) {
  const base = normalizePublicBasePath(basePath);
  const raw = String(url || "/");
  if (!base) return raw;
  const queryIndex = raw.indexOf("?");
  const pathname = queryIndex >= 0 ? raw.slice(0, queryIndex) : raw;
  const suffix = queryIndex >= 0 ? raw.slice(queryIndex) : "";
  if (pathname === base) return "/" + suffix;
  if (pathname.startsWith(base + "/")) return pathname.slice(base.length) + suffix;
  return raw;
}

module.exports = { normalizePublicBasePath, stripPublicBasePath };
