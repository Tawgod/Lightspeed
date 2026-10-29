import { readLightspeedCollection } from './readCollection.js';
// Read-only catalog references. Existing Special Orders category route is preserved
// while these parsing rules are contract-tested for future migration.
export function normalizeProductCategories(result) {
  const found = new Map();
  const visit = value => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== 'object') return;
    const id = value.id || value.category_id || null;
    const name = value.name || value.label || value.category_name || null;
    const looksLikeCategory = Boolean(id && name) &&
      ('parent_id' in value || 'parent' in value || 'children' in value ||
       'category_id' in value || 'category_name' in value ||
       Object.keys(value).some(k => /categor/i.test(k)));
    if (looksLikeCategory) {
      const parentRaw = value.parent_id ?? value.parent?.id ?? value.parent ?? null;
      const parentId = (typeof parentRaw === 'object' ? parentRaw?.id : parentRaw) || null;
      found.set(String(id), { id: String(id), name: String(name), parent_id: parentId ? String(parentId) : null });
    }
    for (const child of Object.values(value)) if (child && typeof child === 'object') visit(child);
  };
  visit(result);
  const direct = Array.isArray(result) ? result :
    Array.isArray(result?.data) ? result.data :
    Array.isArray(result?.categories) ? result.categories :
    Array.isArray(result?.data?.categories) ? result.data.categories : [];
  for (const row of direct) {
    if (!row?.id || !(row.name || row.label)) continue;
    const parentRaw = row.parent_id ?? row.parent?.id ?? row.parent ?? null;
    const parentId = (typeof parentRaw === 'object' ? parentRaw?.id : parentRaw) || null;
    found.set(String(row.id), {
      id: String(row.id), name: String(row.name || row.label),
      parent_id: parentId ? String(parentId) : null
    });
  }
  const pathFor = (id, seen = new Set()) => {
    const row = found.get(String(id));
    if (!row) return '';
    if (!row.parent_id || seen.has(String(id))) return row.name;
    const nextSeen = new Set(seen); nextSeen.add(String(id));
    const parentPath = pathFor(row.parent_id, nextSeen);
    return parentPath ? parentPath + ' › ' + row.name : row.name;
  };
  return [...found.values()].map(row => ({ ...row, path: pathFor(row.id) }))
    .sort((a, b) => a.path.localeCompare(b.path));
}
export function createLightspeedCatalogRead({ transport } = {}) {
  if (typeof transport?.request !== 'function') throw new TypeError('Shared Lightspeed transport required.');
  return Object.freeze({
    async categories() {
      const response = await transport.request('/api/2026-07/product_categories?page_size=1000&include=family');
      return normalizeProductCategories(response);
    },
    async suppliers() { return readLightspeedCollection({ transport, path:'/api/2026-04/suppliers?page_size=1000' }); },
    async brands() { return readLightspeedCollection({ transport, path:'/api/2026-04/brands?page_size=1000' }); },
    async tags() { return readLightspeedCollection({ transport, path:'/api/2026-04/tags?page_size=1000' }); }
  });
}
