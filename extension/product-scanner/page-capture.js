// Browser-injected capture must be self-contained; Chrome serializes this function.
// Used by both the toolbar popup and the scanner review popup.
export function captureSupplierProductPage() {
        const meta = k => document.querySelector('meta[property="'+k+'"],meta[name="'+k+'"]')?.content?.trim() || '';
        const products=[];
        const visit=v=>{if(!v||typeof v!=='object')return;if(Array.isArray(v)){v.forEach(visit);return}if([v['@type']].flat().some(t=>typeof t==='string'&&t.toLowerCase()==='product'))products.push(v);if(v['@graph'])visit(v['@graph'])};
        for(const node of document.querySelectorAll('script[type="application/ld+json"]')){try{visit(JSON.parse(node.textContent))}catch{}}
        const p=products.length===1?products[0]:null;
        const offer=Array.isArray(p?.offers)?p.offers[0]:p?.offers;
        const image=Array.isArray(p?.image)?p.image[0]:p?.image;
        // Never mistake a supplier's SKU/MPN for the store's general SKU or UPC.
        const digits=v=>String(v??'').replace(/[^0-9]/g,'');
        const validGtin=v=>{const n=digits(v);return [8,12,13,14].includes(n.length)?n:'';};
        const upcCandidates=[p?.gtin12,p?.gtin13,p?.gtin14,p?.gtin8,p?.gtin,p?.upc,meta('product:upc'),meta('product:gtin'),meta('gtin'),(document.querySelector('[itemprop="gtin12"],[itemprop="gtin13"],[itemprop="gtin14"],[itemprop="gtin8"],[itemprop="gtin"]')?.getAttribute('content')||document.querySelector('[itemprop="gtin12"],[itemprop="gtin13"],[itemprop="gtin14"],[itemprop="gtin8"],[itemprop="gtin"]')?.textContent)];
        // ACD displays product values as visible label/value pairs; fall back to
        // these only for acdd.com product pages when metadata omits a field.
        const isAcd=/(^|\.)acdd\.com$/i.test(location.hostname);
        const visible=isAcd?(document.body?.innerText||'').slice(0,150000):'';
        const lines=visible.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
        const allLabels='SKU|UPC|EAN|GTIN|Manufacturer|MAP|MSRP|Shipping Weight|Item Weight|Weight|Category|Order By Date|Stock|Quantity';
        const fromLabel=label=>{
          if(!isAcd)return '';
          const re=new RegExp('(?:^|\\s)(?:'+label+')\\s*:\\s*(.*)$','i');
          const nextLabel=new RegExp('\\s+(?:(?:'+allLabels+')\\s*:)','i');
          for(let i=0;i<lines.length;i++){
            const match=lines[i].match(re);
            if(!match)continue;
            let value=match[1].split(nextLabel)[0].trim();
            if(!value&&lines[i+1]&&!new RegExp('^(?:'+allLabels+')\\s*:','i').test(lines[i+1]))value=lines[i+1];
            return value.trim();
          }
          return '';
        };
        const money=value=>{
          const found=String(value||'').match(/(?:\$\s*)?([0-9]+(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)/);
          return found?found[1].replace(/,/g,''):'';
        };
        const acdUpc=validGtin(fromLabel('UPC|EAN|GTIN'));
        const capturedUpc=upcCandidates.map(validGtin).find(Boolean)||acdUpc;
        const acdSupplierSku=fromLabel('SKU');
        const acdManufacturer=fromLabel('Manufacturer');
        const acdMsrp=money(fromLabel('MSRP'));
        const acdMap=money(fromLabel('MAP'));
        const explicitMap=money(meta('product:map')||meta('map_price'));
        const acdWeight=fromLabel('Shipping Weight|Item Weight|Weight').match(/^[0-9]+(?:\.[0-9]+)?\s*(?:lbs?|ounces?|oz|kg|g)?\b/i)?.[0]||'';
        const acdPrice=money((isAcd?visible.match(/(?:^|\n)\s*\$\s*([0-9]+(?:\.[0-9]{2}))/m)?.[1]:null)||'');
        const acdStatus=fromLabel('Category');

        const str=v=>typeof v==='string'?v.trim():'';
        return {sourceUrl:location.href,capturedAt:new Date().toISOString(),candidates:products.length,requiresSelection:products.length>1,product:p?{
          name:str(p.name),description:str(p.description),sku:'',supplierSku:acdSupplierSku||str(p.sku),upc:capturedUpc,
          brand:acdManufacturer||str(typeof p.brand==='string'?p.brand:p.brand?.name),
          imageUrl:str(typeof image==='string'?image:image?.url),mapPrice:acdMap||explicitMap,cost:acdPrice,msrp:acdMsrp,weight:acdWeight,supplierName:isAcd?'ACD Distribution':'',availabilityNote:acdStatus
        }:{name:meta('og:title')||document.title,description:meta('og:description')||meta('description'),sku:'',supplierSku:acdSupplierSku,upc:capturedUpc,brand:acdManufacturer,imageUrl:meta('og:image'),mapPrice:acdMap||explicitMap,cost:acdPrice,msrp:acdMsrp,weight:acdWeight,supplierName:isAcd?'ACD Distribution':'',availabilityNote:acdStatus}};
}
