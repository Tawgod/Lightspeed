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

// Additive diagnostics over the existing normalized category representation.
// A path string by itself is not proof of a valid hierarchy.
export function inspectCategoryHierarchy(result) {
  const categories = normalizeProductCategories(result);
  const byId = new Map(categories.map(row => [row.id, row]));
  const issues = [];
  for (const row of categories) {
    const seen = new Set();
    let current = row;
    while (current) {
      if (seen.has(current.id)) {
        issues.push({ id: row.id, code: 'CATEGORY_CYCLE' });
        break;
      }
      seen.add(current.id);
      if (!current.parent_id) break;
      const parent = byId.get(current.parent_id);
      if (!parent) {
        issues.push({ id: row.id, code: 'CATEGORY_PARENT_MISSING', parentId: current.parent_id });
        break;
      }
      current = parent;
    }
  }
  return { categories, issues, hierarchyValid: issues.length === 0 };
}

// M3: internal evidence projections. No vendor schema or alias authority is
// inferred. Inputs are trusted, single-tenant normalized offline observations.
const catalogText = v => typeof v === 'string' && v.length <= 512 &&
  v.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(v);
const nullableText = v => v === null || catalogText(v);
const evidenceFields = r => catalogText(r?.source) && catalogText(r?.provenance);
const instant = v => typeof v === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) &&
  Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const money = v => typeof v === 'string' && /^(0|[1-9]\d{0,17})(\.\d{1,8})?$/.test(v);

// Alias scope is source-specific. Only verified canonical links are evidence;
// never treat a shipping sender, name similarity or case folding as identity.
export function resolveSupplierIdentity(query, rows, { complete = false } = {}) {
  if (!catalogText(query?.source) || !catalogText(query?.alias) || !Array.isArray(rows))
    throw new TypeError('Source, exact alias and evidence rows required.');
  const issues = new Set(), matches = new Map();
  for (const r of rows) {
    if (!evidenceFields(r) || !catalogText(r.alias) || !catalogText(r.supplierId) ||
        typeof r.verified !== 'boolean' || !instant(r.observedAt)) {
      issues.add('MALFORMED_ALIAS'); continue;
    }
    if (r.source !== query.source || r.alias !== query.alias) continue;
    if (!r.verified) { issues.add('UNVERIFIED_ALIAS'); continue; }
    const e = { supplierId:r.supplierId, source:r.source, alias:r.alias,
      provenance:r.provenance, observedAt:r.observedAt };
    const list = matches.get(r.supplierId) || [];
    if (!list.some(x=>JSON.stringify(x)===JSON.stringify(e))) list.push(e);
    matches.set(r.supplierId,list);
  }
  const candidates = [...matches].map(([supplierId,evidence])=>({supplierId,evidence}));
  const coverage = complete === true && issues.size === 0;
  const status = candidates.length > 1 ? 'AMBIGUOUS' : !coverage ? 'INCOMPLETE' :
    candidates.length ? 'EXACT_UNIQUE' : 'NO_MATCH';
  return {status, complete:coverage, candidates, issues:[...issues]};
}

// All mappings are observations: no promotion, overwrite or default primary.
// Separate SKU evidence by canonical supplier and exact product/variant.
export function inspectSupplierProductLinks(target, rows, { complete = false } = {}) {
  if (!catalogText(target?.productId) || !nullableText(target?.variantId) || !Array.isArray(rows))
    throw new TypeError('Exact product and explicit variant scope required.');
  const issues = new Set(), groups = new Map();
  for (const r of rows) {
    if (!catalogText(r?.productId) || !nullableText(r.variantId) ||
        !catalogText(r.supplierId) || !nullableText(r.supplierSku) ||
        ![true,false,null].includes(r.primary) || !evidenceFields(r) || !instant(r.observedAt)) {
      issues.add('MALFORMED_LINK'); continue;
    }
    if (r.productId !== target.productId || r.variantId !== target.variantId) continue;
    const group = groups.get(r.supplierId) || {supplierId:r.supplierId, observations:[]};
    const e = {supplierSku:r.supplierSku, primary:r.primary, source:r.source,
      provenance:r.provenance, observedAt:r.observedAt};
    if (!group.observations.some(x=>JSON.stringify(x)===JSON.stringify(e))) group.observations.push(e);
    groups.set(r.supplierId,group);
  }
  const links = [...groups.values()].map(g=>{
    const skus = new Set(g.observations.map(r=>r.supplierSku).filter(v=>v!==null));
    const primary = new Set(g.observations.map(r=>r.primary).filter(v=>v!==null));
    if (skus.size > 1) issues.add('CONFLICTING_SUPPLIER_SKU');
    if (primary.size > 1) issues.add('CONFLICTING_PRIMARY_STATUS');
    return {...g, supplierSku:skus.size===1?[...skus][0]:null,
      primary:primary.size===1?[...primary][0]:null};
  });
  const primaries = links.filter(r=>r.primary===true);
  if (primaries.length > 1) issues.add('MULTIPLE_PRIMARY_SUPPLIERS');
  const coverage = complete === true && issues.size === 0;
  return {links, complete:coverage, primarySupplierId:coverage && primaries.length===1 &&
      links.every(r=>r.primary!==null) ? primaries[0].supplierId:null, issues:[...issues]};
}

// Exact decimal observations; do not derive one price from another, convert
// currency or pick a winner across conflicting source values.
export function inspectCatalogPrices(target, rows, { complete = false } = {}) {
  if (!catalogText(target?.productId) || !nullableText(target?.variantId) || !Array.isArray(rows))
    throw new TypeError('Exact product and explicit variant scope required.');
  const groups = new Map(), issues = new Set();
  for (const r of rows) {
    if (!catalogText(r?.productId) || !nullableText(r.variantId) ||
        !['COST','MSRP','RETAIL'].includes(r.kind) ||
        !nullableText(r.supplierId) || !nullableText(r.outletId) ||
        (r.amount!==null && !money(r.amount)) ||
        (r.currency!==null && (typeof r.currency!=='string' || !/^[A-Z]{3}$/.test(r.currency))) ||
        (r.amount!==null && r.currency===null) || !evidenceFields(r) || !instant(r.observedAt)) {
      issues.add('MALFORMED_PRICE'); continue;
    }
    if (r.productId!==target.productId || r.variantId!==target.variantId) continue;
    const key=JSON.stringify([r.kind,r.supplierId,r.outletId,r.currency]);
    const group=groups.get(key)||{kind:r.kind,supplierId:r.supplierId,outletId:r.outletId,
      currency:r.currency,observations:[]};
    const e={amount:r.amount,source:r.source,provenance:r.provenance,observedAt:r.observedAt};
    if (!group.observations.some(x=>JSON.stringify(x)===JSON.stringify(e))) group.observations.push(e);
    groups.set(key,group);
  }
  const prices=[...groups.values()].map(g=>{
    const values=new Set(g.observations.map(r=>r.amount).filter(v=>v!==null));
    if(values.size>1) issues.add('CONFLICTING_PRICE');
    return {...g,amount:values.size===1?[...values][0]:null};
  });
  return {prices,complete:complete===true && issues.size===0,issues:[...issues]};
}

// Strict flat normalized reference inputs only. Reuse the existing hierarchy
// diagnostic after rejecting malformed/duplicate identities; no raw vendor
// envelope inference or completeness claim from a page length.
export function inspectCatalogReferences(input, { complete = false } = {}) {
  const kinds=['suppliers','brands','manufacturers','departments','categories','tags'];
  const references={}, issues=[];
  for(const kind of kinds){
    const rows=input?.[kind], ids=new Set(), valid=[];
    if(!Array.isArray(rows)){issues.push({kind,code:'MISSING_REFERENCE_LIST'});references[kind]=[];continue;}
    for(const r of rows){
      if(!catalogText(r?.id)||!catalogText(r.name)||!evidenceFields(r)||
        ((kind==='categories'||kind==='departments')&&!nullableText(r.parent_id))){
        issues.push({kind,code:'MALFORMED_REFERENCE'});continue;
      }
      if(ids.has(r.id)){issues.push({kind,code:'DUPLICATE_REFERENCE_ID',id:r.id});continue;}
      ids.add(r.id);
      valid.push({id:r.id,name:r.name,source:r.source,provenance:r.provenance,
        ...((kind==='categories'||kind==='departments')?{parent_id:r.parent_id}:{})});
    }
    references[kind]=valid;
    if(kind==='categories'||kind==='departments'){
      const diagnostic=inspectCategoryHierarchy(valid.map(r=>({id:r.id,name:r.name,parent_id:r.parent_id})));
      issues.push(...diagnostic.issues.map(r=>({...r,kind})));
    }
  }
  return {references,complete:complete===true&&issues.length===0,issues};
}

// M4: metadata evidence only. No URL dereference, Drive access, upload,
// permission grant or asset assignment. Approved hosts are trusted server config.
function assetReference(ref, hosts) {
  if (!ref || typeof ref !== 'object' || typeof ref.value !== 'string' ||
      ref.value.length > 2048 || /[\u0000-\u0020\u007f\\]/u.test(ref.value)) return null;
  if (ref.kind === 'DRIVE_FILE' || ref.kind === 'STORAGE_ID') {
    return /^[A-Za-z0-9_-]{1,200}$/.test(ref.value) ? {kind:ref.kind,value:ref.value} : null;
  }
  if (ref.kind !== 'HTTPS_URL' || !ref.value.startsWith('https://')) return null;
  try {
    const url = new URL(ref.value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
        url.search || url.hash || !hosts.has(url.hostname) ||
        url.href !== ref.value) return null;
    return {kind:ref.kind,value:ref.value};
  } catch { return null; }
}

export function inspectProductAssets(target, rows, {complete=false, approvedHosts=[]}={}) {
  if (!catalogText(target?.productId) || !nullableText(target?.variantId) ||
      !Array.isArray(rows) || !Array.isArray(approvedHosts) ||
      approvedHosts.some(h=>typeof h!=='string'||! /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(h)))
    throw new TypeError('Exact target, asset evidence and trusted host configuration required.');
  const hosts=new Set(approvedHosts), issues=new Set(), groups=new Map();
  for (const r of rows) {
    if (!catalogText(r?.productId)||!nullableText(r.variantId)) {
      issues.add('MALFORMED_TARGET');continue;
    }
    if (r.productId!==target.productId||r.variantId!==target.variantId) continue;
    const image=r.kind==='IMAGE', document=['MANUAL','DOCUMENT'].includes(r.kind);
    if (!catalogText(r.assetId)||(!image&&!document)||
        !(image ? ['PRIMARY','GALLERY'].includes(r.role) : r.role==='SUPPORTING')||
        !(image ? Number.isSafeInteger(r.slot)&&r.slot>=0&&r.slot<=999 : r.slot===null)||
        !['AVAILABLE','MISSING','UNKNOWN'].includes(r.availability)||
        !evidenceFields(r)||!instant(r.observedAt)) {
      issues.add('MALFORMED_ASSET');continue;
    }
    const ref=r.reference===null ? null : assetReference(r.reference,hosts);
    if ((r.reference!==null&&!ref)||(r.availability==='AVAILABLE'&&!ref)) {
      issues.add('INVALID_ASSET_REFERENCE');continue;
    }
    const e={kind:r.kind,role:r.role,slot:r.slot,availability:r.availability,
      reference:ref,source:r.source,provenance:r.provenance,observedAt:r.observedAt};
    const group=groups.get(r.assetId)||{assetId:r.assetId,observations:[]};
    if(!group.observations.some(x=>JSON.stringify(x)===JSON.stringify(e))) group.observations.push(e);
    groups.set(r.assetId,group);
  }
  const assets=[...groups.values()].map(g=>{
    const values=new Set(g.observations.map(({source,provenance,observedAt,...v})=>JSON.stringify(v)));
    if(values.size!==1) issues.add('CONFLICTING_ASSET');
    return {...g,metadata:values.size===1?JSON.parse([...values][0]):null};
  });
  const slots=new Map(), refs=new Map(), primary=[];
  for(const a of assets){
    const m=a.metadata;if(!m)continue;
    if(m.kind==='IMAGE'){
      if(slots.has(m.slot))issues.add('DUPLICATE_IMAGE_SLOT');
      slots.set(m.slot,a.assetId);
      if(m.role==='PRIMARY')primary.push(a);
    }
    if(m.reference){
      const key=JSON.stringify(m.reference);
      if(refs.has(key))issues.add('DUPLICATE_ASSET_REFERENCE');
      refs.set(key,a.assetId);
    }
  }
  if(primary.length>1)issues.add('MULTIPLE_PRIMARY_IMAGES');
  const coverage=complete===true&&issues.size===0;
  assets.sort((a,b)=>(a.metadata?.slot??1000)-(b.metadata?.slot??1000)||a.assetId.localeCompare(b.assetId));
  return {assets,complete:coverage,primaryImageId:coverage&&primary.length===1&&
    primary[0].metadata.availability==='AVAILABLE'?primary[0].assetId:null,
    missingAssetIds:assets.filter(a=>a.metadata?.availability==='MISSING').map(a=>a.assetId),
    issues:[...issues]};
}
