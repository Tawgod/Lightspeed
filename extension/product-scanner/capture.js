// Standalone supplier-page capture. No catalog crawling or spreadsheet dependencies.
// Run only after the employee explicitly requests a scan of the active tab.
export function captureProductPage(doc = document, pageUrl = location.href) {
  const text = (v) => typeof v === 'string' ? v.trim() : '';
  const meta = (key) => text(doc.querySelector('meta[property="'+key+'"],meta[name="'+key+'"]')?.content);
  const nodes = [...doc.querySelectorAll('script[type="application/ld+json"]')];
  const products = [];
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) return value.forEach(visit);
    const types = [value['@type']].flat();
    if (types.some(t => typeof t === 'string' && t.toLowerCase() === 'product')) products.push(value);
    if (value['@graph']) visit(value['@graph']);
  }
  for (const node of nodes) {
    try { visit(JSON.parse(node.textContent)); } catch { /* ignore invalid structured data */ }
  }
  const p = products.length === 1 ? products[0] : null;
  const offer = Array.isArray(p?.offers) ? p.offers[0] : p?.offers;
  const image = Array.isArray(p?.image) ? p.image[0] : p?.image;
  const brand = typeof p?.brand === 'string' ? p.brand : p?.brand?.name;
  return {
    sourceUrl: pageUrl,
    capturedAt: new Date().toISOString(),
    candidates: products.length,
    requiresSelection: products.length > 1,
    product: p ? {
      name: text(p.name), description: text(p.description), sku: text(p.sku),
      upc: text(p.gtin12 || p.gtin13 || p.gtin14 || p.gtin8),
      manufacturerPartNumber: text(p.mpn), brand: text(brand),
      imageUrl: text(typeof image === 'string' ? image : image?.url),
      advertisedPrice: offer?.price ?? null, currency: text(offer?.priceCurrency)
    } : {
      name: meta('og:title') || text(doc.title),
      description: meta('og:description') || meta('description'),
      sku: '', upc: '', manufacturerPartNumber: '', brand: '',
      imageUrl: meta('og:image'), advertisedPrice: null, currency: ''
    }
  };
}
