// Extracted verbatim from legacy Special Orders scoring rules on consolidated baseline f50c330.
// Legacy route retains its existing functions until parity/consumer migration is approved.
export function normalizeMatchText(v) {
  return String(v || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function matchTokens(v) {
  const stop = new Set(['the','and','for','with','from','set','pack','box','kit','edition','new']);
  return normalizeMatchText(v).split(' ').filter(t => t.length > 1 && !stop.has(t));
}

export function scorePotentialMatch(query, candidate) {
  const qRaw = String(query || '').trim();
  const q = normalizeMatchText(qRaw);
  const qTokens = matchTokens(qRaw);
  const sku = normalizeMatchText(candidate.sku);
  const upc = normalizeMatchText(candidate.upc);
  const supplierSku = normalizeMatchText(candidate.supplier_sku);
  const name = normalizeMatchText(candidate.name);
  const desc = normalizeMatchText(candidate.description);
  const supplierDesc = normalizeMatchText(candidate.supplier_description);
  const brand = normalizeMatchText(candidate.brand);
  const manufacturer = normalizeMatchText(candidate.manufacturer_text);

  let score = 0;
  const reasons = [];

  if (q && (q === sku || q === upc || q === supplierSku)) {
    score += 100;
    reasons.push('exact code');
  }
  if (q && q === name) {
    score += 80;
    reasons.push('exact name');
  }

  const haystacks = [
    ['name', name, 34],
    ['description', desc, 22],
    ['supplier description', supplierDesc, 28],
    ['brand', brand, 18],
    ['manufacturer', manufacturer, 18]
  ];
  for (const [label, textValue, weight] of haystacks) {
    if (!textValue || qTokens.length === 0) continue;
    const textTokens = new Set(matchTokens(textValue));
    const hits = qTokens.filter(t => textTokens.has(t));
    if (hits.length) {
      const ratio = hits.length / qTokens.length;
      score += Math.round(weight * ratio);
      if (ratio >= 0.5) reasons.push(`${label} keywords`);
    }
    if (q.length >= 5 && textValue.includes(q)) {
      score += 18;
      reasons.push(`${label} phrase`);
    }
  }

  // Partial code match is useful for suppliers that add/remove prefixes or punctuation.
  const compactQuery = q.replace(/ /g, '');
  for (const code of [sku, supplierSku, upc]) {
    const compactCode = code.replace(/ /g, '');
    if (compactQuery.length >= 4 && compactCode.length >= 4 &&
        compactQuery !== compactCode &&
        (compactCode.includes(compactQuery) || compactQuery.includes(compactCode))) {
      score += 24;
      reasons.push('partial code');
      break;
    }
  }

  return { score: Math.min(score, 100), reasons: [...new Set(reasons)] };
}

// Internal M2 evidence contract, not a vendor adapter or authorization decision.
// All records belong to one trusted catalog/tenant. Scope coverage is asserted
// by a trusted fixture producer, never inferred from a vendor response.
const kinds = new Set(['SKU','UPC','GTIN','SUPPLIER_SKU','MANUFACTURER_PART']);
const exactText = value => typeof value === 'string' && value.length <= 256 &&
  value.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(value);
function scopeField(kind) {
  return kind === 'SUPPLIER_SKU' ? 'supplierId' :
    kind === 'MANUFACTURER_PART' ? 'manufacturerId' : null;
}
function validKey(key) {
  if (!key || !kinds.has(key.kind) || !exactText(key.exactValue)) return false;
  const scope = scopeField(key.kind);
  return ['supplierId','manufacturerId'].every(field =>
    field === scope ? exactText(key[field]) : key[field] == null);
}
const validNullableId = value => value === null || exactText(value);

// Records describe a product or one independently identified variant. A parent
// product and its variant are different targets; do not collapse by parent ID.
export function inspectTypedProductIdentity(query, records, { complete = false } = {}) {
  if (!validKey(query)) throw new TypeError('Typed exact identifier and applicable scope required.');
  if (!Array.isArray(records)) throw new TypeError('Identity records required.');
  const matches = new Map(), targets = new Map(), issues = new Set();
  const scope = scopeField(query.kind);
  for (const row of records) {
    if (!row || !exactText(row.productId) || !validNullableId(row.variantId) ||
        ![true,false,null].includes(row.active) || !Array.isArray(row.identifiers)) {
      issues.add('MALFORMED_TARGET'); continue;
    }
    const key = JSON.stringify([row.productId,row.variantId]);
    if (targets.has(key) && targets.get(key) !== row.active) issues.add('CONFLICTING_ACTIVITY');
    targets.set(key,row.active);
    for (const item of row.identifiers) {
      if (!validKey(item) || !exactText(item.source) || !exactText(item.provenance)) {
        issues.add('MALFORMED_IDENTIFIER'); continue;
      }
      if (item.kind !== query.kind || (scope && item[scope] !== query[scope])) continue;
      // No cross-kind conversion, barcode padding, case folding or trimming.
      if (item.exactValue !== query.exactValue) continue;
      const match = matches.get(key) || {
        productId:row.productId, variantId:row.variantId, active:row.active, evidence:[]
      };
      const evidence = {kind:item.kind, exactValue:item.exactValue,
        supplierId:item.supplierId ?? null, manufacturerId:item.manufacturerId ?? null,
        source:item.source, provenance:item.provenance};
      if (!match.evidence.some(x => JSON.stringify(x) === JSON.stringify(evidence)))
        match.evidence.push(evidence);
      matches.set(key,match);
    }
  }
  const candidates = [...matches.values()];
  const coverage = complete === true && issues.size === 0;
  const status = candidates.length > 1 ? 'AMBIGUOUS' : !coverage ? 'INCOMPLETE' :
    candidates.length ? 'EXACT_UNIQUE' : 'NO_MATCH';
  return {status, complete:coverage, candidates, issues:[...issues]};
}
