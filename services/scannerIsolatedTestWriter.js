// Isolated Lightspeed TEST-TENANT writer only. Never use the production credentials.
// Feature remains unavailable without an explicit, distinct test-store configuration.
const domainValid=s=>/^[a-z0-9][a-z0-9-]{1,60}$/.test(s||'');
export function createScannerIsolatedTestWriter({enabled=false,domain='',token='',productionDomain='',confirmation='',fetchImpl=globalThis.fetch}={}){
  const testDomain=String(domain).trim().toLowerCase();
  const liveDomain=String(productionDomain).trim().toLowerCase();
  if(!enabled || !domainValid(testDomain) || !domainValid(liveDomain) ||
    testDomain===liveDomain || !token || confirmation!=='ISOLATED_TEST_TENANT')return null;
  const base='https://'+testDomain+'.retail.lightspeed.app/api/2026-07/products';
  const headers={Authorization:'Bearer '+token,Accept:'application/json'};
  async function request(url,method='GET',body){
    const response=await fetchImpl(url,{method,redirect:'error',cache:'no-store',
      headers:{...headers,...(body?{'Content-Type':'application/json'}:{})},
      ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(9000)});
    // Keep error opaque: never echo tokens or full vendor response.
    if(!response.ok)throw Object.assign(new Error('Isolated Lightspeed test API rejected request.'),{status:response.status,mayHaveWritten:method==='POST'});
    const data=await response.json();
    return data;
  }
  return async product=>{
    const sku=String(product.sku||product.supplierSku||'').trim();
    if(!sku||!product.name)throw new Error('Test item requires a name and SKU.');
    const existing=await request(base+'?sku='+encodeURIComponent(sku));
    if(!Array.isArray(existing?.data))throw new Error('Test-store duplicate lookup incomplete.');
    if(existing.data.length)throw Object.assign(new Error('Product SKU already exists in isolated Lightspeed test store.'),{code:'DUPLICATE'});
    const payload={name:product.name,sku,description:product.description||'',
      supplier_code:product.supplierSku||sku,is_active:false};
    if(product.cost!=null)payload.supply_price=Number(product.cost);
    // Important: supplier IDs, barcodes, tax/retail pricing and inventory need
    // store-specific mappings; do not carry production IDs into a test tenant.
    const created=await request(base,'POST',payload);
    const result=created?.data||created;
    if(!result?.id)throw Object.assign(new Error('Test creation response lacked a product ID; inspect test store before retry.'),{mayHaveWritten:true});
    return {id:String(result.id),sku,name:product.name};
  };
}
