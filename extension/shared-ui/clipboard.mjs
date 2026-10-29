/* Clipboard tools shared by Hobby Corner frontends.
 * Plain text is never trimmed, normalized, or numerically parsed.
 * Rich HTML is sanitized to a small semantic allowlist before writing.
 */
const TAGS = new Set(['A','B','STRONG','I','EM','U','S','P','BR','DIV','SPAN',
  'UL','OL','LI','PRE','CODE','BLOCKQUOTE','TABLE','THEAD','TBODY','TR','TH','TD']);
const CSS_PROPERTIES = ['color','background-color','font-weight','font-style','text-decoration','text-align','white-space'];

export function sanitizeCopyHtml(html, documentRef = globalThis.document) {
  if (typeof html !== 'string') throw new TypeError('HTML must be a string');
  if (!documentRef?.createElement) throw new Error('HTML sanitizer requires a browser Document');
  const template = documentRef.createElement('template');
  template.innerHTML = html;
  function copy(node) {
    if (node.nodeType === 3) return documentRef.createTextNode(node.textContent || '');
    if (node.nodeType !== 1) return documentRef.createDocumentFragment();
    const tag = node.tagName.toUpperCase();
    const safe = TAGS.has(tag) ? documentRef.createElement(tag.toLowerCase()) : documentRef.createDocumentFragment();
    if (tag === 'A' && safe.nodeType === 1) {
      const href = node.getAttribute('href') || '';
      if (/^(https?:|mailto:)/i.test(href.trim())) safe.setAttribute('href', href.trim());
    }
    if (safe.nodeType === 1 && node.hasAttribute('style')) {
      const source = node.style;
      for (const prop of CSS_PROPERTIES) {
        const value = source.getPropertyValue(prop);
        // Reject CSS function calls, quotes, URLs and special characters.
        if (value && /^[#(),.%\sa-zA-Z0-9-]+$/.test(value) && !/url\s*\(/i.test(value)) {
          safe.style.setProperty(prop, value);
        }
      }
    }
    for (const child of Array.from(node.childNodes)) safe.append(copy(child));
    return safe;
  }
  const root = documentRef.createElement('div');
  for (const child of Array.from(template.content.childNodes)) root.append(copy(child));
  return root.innerHTML;
}

export async function copyHobbyCornerField({
  plainText, formattedHtml = null
}, { clipboard = globalThis.navigator?.clipboard, ClipboardItemType = globalThis.ClipboardItem, documentRef = globalThis.document } = {}) {
  if (typeof plainText !== 'string') throw new TypeError('plainText must be a string');
  if (!clipboard) throw new Error('Clipboard is unavailable; select and copy the text manually');
  if (formattedHtml !== null && typeof formattedHtml !== 'string') throw new TypeError('formattedHtml must be a string or null');
  if (formattedHtml !== null && ClipboardItemType && typeof clipboard.write === 'function') {
    const sanitizedHtml = sanitizeCopyHtml(formattedHtml, documentRef);
    const item = new ClipboardItemType({
      'text/plain': new Blob([plainText], {type:'text/plain'}),
      'text/html': new Blob([sanitizedHtml], {type:'text/html'})
    });
    try {
      await clipboard.write([item]);
      return {format:'rich-and-plain'};
    } catch { /* Unavailable rich format: exact plain-text fallback. */ }
  }
  if (typeof clipboard.writeText !== 'function') throw new Error('Plain-text clipboard is unavailable');
  await clipboard.writeText(plainText);
  return {format:'plain'};
}
