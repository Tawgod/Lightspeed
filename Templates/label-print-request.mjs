// Label-only consumer adapter. Does not look up, mutate, or authorize products.
export function buildLabelPrintRequest({sourceId='SELECTED_PRODUCTS',templateId='Avery_5960',startRow=1,startCol=1,customText='',items}={}) {
  const fail = message => { throw new TypeError(message); };
  const integer = (n,min,max) => Number.isSafeInteger(n) && n>=min && n<=max;
  const string = (v) => typeof v==='string';
  if (!string(sourceId) || !/^[A-Za-z0-9_-]{1,128}$/.test(sourceId)) fail('Invalid print source reference');
  if (!['Avery_5960','Special Order Label'].includes(templateId)) fail('Unsupported label template');
  if (!integer(startRow,1,10)||!integer(startCol,1,3)) fail('Invalid sheet position');
  if (!string(customText)) fail('Invalid custom text');
  if (!Array.isArray(items)) fail('Expected selected label items');
  const selected=[];
  let count=0;
  for (const item of items) {
    if (!item || !integer(item.qty,0,1000)||!integer(item.soQty??0,0,item.qty)) fail('Invalid label quantities');
    if (!item.qty) continue;
    if (!string(item.sku)||!item.sku.trim()||item.sku==='UNKNOWN') fail('Missing exact SKU');
    if (!string(item.name)||!item.name.trim()) fail('Missing product name');
    if (!string(item.price)||!/^\$[0-9]+\.[0-9]{2}$/.test(item.price)) fail('Current formatted retail price required');
    const customerName=item.customerName??'';
    if (!string(customerName)||((item.soQty??0)>0&&!customerName.trim())) fail('Special order customer required');
    count+=item.qty;
    if(count>1000) fail('Maximum 1000 labels per request');
    selected.push({sku:item.sku,name:item.name,price:item.price,qty:item.qty,soQty:item.soQty??0,customerName});
  }
  if(!selected.length) fail('Select at least one label');
  return {poId:sourceId,startRow,startCol,templateId,customText,items:selected};
}
