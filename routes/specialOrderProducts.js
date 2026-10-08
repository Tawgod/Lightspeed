export function registerSpecialOrderProductRoutes(router, deps) {
  const {
    pool,
    requireDb,
    lightspeedDomain,
    lightspeedToken,
    liveMode,
    allowProductWrites,
    lightspeedVersionedFetch,
    lightspeedFetch,
    ensureLightspeedTag,
    uploadLightspeedImageFromUrl,
    upsertLocalProduct,
    upsertProductIdentifiers,
    matchTokens,
    scorePotentialMatch
  } = deps;

  router.get('/product-categories', async (req, res) => {
    try {
      const result = await lightspeedVersionedFetch(
        lightspeedDomain,
        lightspeedToken,
        '/product_categories?page_size=1000&include=family',
        {},
        '2026-07'
      );

      // Lightspeed has returned this resource in both flat and nested envelope shapes.
      // Collect category-looking objects recursively, then reconstruct readable paths
      // from parent ids when the response is flat.
      const found = new Map();
      const visit = (value) => {
        if (Array.isArray(value)) {
          value.forEach(visit);
          return;
        }
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
          found.set(String(id), {
            id:String(id),
            name:String(name),
            parent_id:parentId ? String(parentId) : null
          });
        }

        for (const child of Object.values(value)) {
          if (child && typeof child === 'object') visit(child);
        }
      };
      visit(result);

      // Fallback for the common direct-array/data-array shapes where category objects
      // contain only id/name and no explicit category-named fields.
      const directRows =
        Array.isArray(result) ? result :
        Array.isArray(result?.data) ? result.data :
        Array.isArray(result?.categories) ? result.categories :
        Array.isArray(result?.data?.categories) ? result.data.categories :
        [];
      for (const row of directRows) {
        if (!row?.id || !(row.name || row.label)) continue;
        const parentRaw = row.parent_id ?? row.parent?.id ?? row.parent ?? null;
        const parentId = (typeof parentRaw === 'object' ? parentRaw?.id : parentRaw) || null;
        found.set(String(row.id), {
          id:String(row.id),
          name:String(row.name || row.label),
          parent_id:parentId ? String(parentId) : null
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

      const categories = [...found.values()]
        .map(row => ({ ...row, path:pathFor(row.id) }))
        .sort((a,b) => a.path.localeCompare(b.path));

      console.log('[special-orders] Lightspeed categories parsed', {
        topLevelKeys: result && typeof result === 'object' && !Array.isArray(result) ? Object.keys(result) : [],
        count: categories.length
      });

      res.set('Cache-Control','no-store');
      res.json(categories);
    } catch (error) {
      console.error('[special-orders] category load failed:', error);
      res.status(error.status || 502).json({ error:error.message });
    }
  });

  async function reconcileLocalProducts({limit=250,sku=null,apply=true,source='manual'}={}) {
    const lockKey=781091;
    const lock=await pool.query('SELECT pg_try_advisory_lock($1) AS locked',[lockKey]);
    if(!lock.rows[0]?.locked) return {busy:true,checked:0,matched:0,repaired:0,flagged:0,deleted:0,protected:0,conflicts:0,errors:[]};

    const summary={busy:false,checked:0,matched:0,repaired:0,flagged:0,deleted:0,protected:0,conflicts:0,errors:[]};
    try {
      const args=[];
      let where="(p.lightspeed_product_id IS NOT NULL OR EXISTS (SELECT 1 FROM product_identifiers pi WHERE pi.product_id=p.id AND pi.identifier_type='LIGHTSPEED_UUID'))";
      if(sku){
        args.push(String(sku));
        where+=" AND lower(coalesce(p.sku,''))=lower($"+args.length+")";
      }
      args.push(Math.max(1,Math.min(Number(limit)||250,500)));
      const rows=await pool.query(`
        SELECT p.id,p.name,p.sku,p.lightspeed_product_id,p.lightspeed_missing_count,
               (SELECT pi.identifier_value
                FROM product_identifiers pi
                WHERE pi.product_id=p.id AND pi.identifier_type='LIGHTSPEED_UUID'
                ORDER BY pi.is_primary DESC,pi.updated_at DESC LIMIT 1) AS mapped_uuid
        FROM products p
        WHERE ${where}
        ORDER BY CASE WHEN p.lightspeed_reconcile_status LIKE 'MISSING%' THEN 0 ELSE 1 END,
                 p.last_reconciled_at NULLS FIRST,p.id
        LIMIT ${args.length}
      `,args);

      for(const local of rows.rows){
        summary.checked++;
        let uuid=local.lightspeed_product_id||local.mapped_uuid||null;
        let remote=null;

        if(uuid){
          try {
            const r=await lightspeedVersionedFetch(lightspeedDomain,lightspeedToken,'/products/'+encodeURIComponent(uuid),{},'2026-07');
            remote=r?.data||r;
          } catch(error) {
            if(Number(error.status)!==404){
              summary.errors.push({sku:local.sku,id:local.id,error:error.message});
              continue;
            }
          }
        }

        if(!remote && local.sku){
          try {
            const r=await lightspeedVersionedFetch(
              lightspeedDomain,lightspeedToken,'/products?sku='+encodeURIComponent(String(local.sku).toLowerCase()),{},'2026-07'
            );
            const candidates=Array.isArray(r?.data)?r.data:[];
            remote=candidates.find(x=>String(x?.sku||'').trim().toLowerCase()===String(local.sku).trim().toLowerCase())||null;
          } catch(error) {
            summary.errors.push({sku:local.sku,id:local.id,error:error.message});
            continue;
          }
        }

        if(remote?.id){
          const conflict=await pool.query(
            'SELECT id,sku FROM products WHERE lightspeed_product_id=$1 AND id<>$2 LIMIT 1',
            [remote.id,local.id]
          );
          if(conflict.rows[0]){
            summary.conflicts++;
            await pool.query(`
              UPDATE products SET lightspeed_reconcile_status='UUID_CONFLICT',last_reconciled_at=now()
              WHERE id=$1
            `,[local.id]);
            continue;
          }

          if(String(uuid||'')!==String(remote.id)){
            summary.repaired++;
            await pool.query(
              'UPDATE products SET lightspeed_product_id=$1,updated_at=now() WHERE id=$2',
              [remote.id,local.id]
            );
          } else {
            summary.matched++;
          }

          await pool.query(`
            INSERT INTO product_identifiers
              (product_id,identifier_type,identifier_value,normalized_value,source,is_primary,updated_at)
            VALUES ($1,'LIGHTSPEED_UUID',$2,$2,'reconciliation',true,now())
            ON CONFLICT (identifier_type, normalized_value, (COALESCE(supplier_id,0)))
            DO UPDATE SET product_id=EXCLUDED.product_id,identifier_value=EXCLUDED.identifier_value,
                          source='reconciliation',is_primary=true,updated_at=now()
          `,[local.id,String(remote.id)]);

          await pool.query(`
            UPDATE products
            SET lightspeed_reconcile_status=$2,last_reconciled_at=now(),
                lightspeed_missing_count=0,lightspeed_missing_since=NULL
            WHERE id=$1
          `,[local.id,String(uuid||'')===String(remote.id)?'MATCHED':'REPAIRED']);
          continue;
        }

        const refs=await pool.query(`
          SELECT
            (SELECT count(*) FROM special_order_items x WHERE x.product_id=$1)::int AS special_orders,
            (SELECT count(*) FROM supplier_order_items x WHERE x.product_id=$1)::int AS supplier_orders,
            (SELECT count(*) FROM inventory_allocations x WHERE x.product_id=$1)::int AS allocations,
            (SELECT count(*) FROM preorder_products x WHERE x.product_id=$1)::int AS preorders,
            (SELECT count(*) FROM receiving_events x WHERE x.product_id=$1)::int AS receiving
        `,[local.id]);
        const referenceCount=Object.values(refs.rows[0]||{}).reduce((n,v)=>n+Number(v||0),0);
        const missCount=Number(local.lightspeed_missing_count||0)+1;

        if(referenceCount>0){
          summary.protected++;
          await pool.query(`
            UPDATE products SET lightspeed_reconcile_status='MISSING_REFERENCED',
              last_reconciled_at=now(),lightspeed_missing_count=$2,
              lightspeed_missing_since=COALESCE(lightspeed_missing_since,now())
            WHERE id=$1
          `,[local.id,missCount]);
          continue;
        }

        if(apply && missCount>=2){
          await pool.query('DELETE FROM products WHERE id=$1',[local.id]);
          summary.deleted++;
        }else{
          summary.flagged++;
          await pool.query(`
            UPDATE products SET lightspeed_reconcile_status='MISSING',
              last_reconciled_at=now(),lightspeed_missing_count=$2,
              lightspeed_missing_since=COALESCE(lightspeed_missing_since,now())
            WHERE id=$1
          `,[local.id,missCount]);
        }
      }

      await pool.query(`
        INSERT INTO product_reconcile_runs
          (source,checked_count,matched_count,repaired_count,flagged_count,deleted_count,
           protected_count,conflict_count,error_count,details)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
      `,[
        source,summary.checked,summary.matched,summary.repaired,summary.flagged,summary.deleted,
        summary.protected,summary.conflicts,summary.errors.length,JSON.stringify({sku:sku||null,errors:summary.errors.slice(0,50)})
      ]);
      return summary;
    } finally {
      await pool.query('SELECT pg_advisory_unlock($1)',[lockKey]).catch(()=>{});
    }
  }

  router.post('/reconcile/products', requireDb, async (req,res)=>{
    try {
      const result=await reconcileLocalProducts({
        limit:req.body?.limit||250,
        sku:req.body?.sku||null,
        apply:req.body?.apply!==false,
        source:'manual'
      });
      res.json(result);
    } catch(error) {
      res.status(error.status||500).json({error:error.message});
    }
  });

  router.get('/reconcile/products/status', requireDb, async (req,res)=>{
    const latest=await pool.query('SELECT * FROM product_reconcile_runs ORDER BY created_at DESC LIMIT 1');
    const pending=await pool.query(`
      SELECT lightspeed_reconcile_status,count(*)::int AS count
      FROM products
      WHERE lightspeed_reconcile_status<>'MATCHED'
      GROUP BY lightspeed_reconcile_status
      ORDER BY lightspeed_reconcile_status
    `);
    res.json({latest:latest.rows[0]||null,pending:pending.rows});
  });

  // Twice-daily conservative cleanup. Advisory locking makes this safe across replicas.
  setTimeout(()=>{
    reconcileLocalProducts({limit:250,apply:true,source:'scheduled'}).catch(
      e=>console.error('[special-orders] scheduled product reconciliation failed',e)
    );
  },120000);
  const reconcileTimer=setInterval(()=>{
    reconcileLocalProducts({limit:250,apply:true,source:'scheduled'}).catch(
      e=>console.error('[special-orders] scheduled product reconciliation failed',e)
    );
  },12*60*60*1000);
  if(reconcileTimer.unref)reconcileTimer.unref();

  router.get('/brands', async (req, res) => {
    res.set('Cache-Control','no-store');
    try {
      const result=await lightspeedVersionedFetch(
        lightspeedDomain,lightspeedToken,'/brands?page_size=1000',{},'2026-04'
      );
      const rows=Array.isArray(result?.data)?result.data:(Array.isArray(result)?result:[]);
      res.json(rows.map(x=>({id:x.id,name:x.name})).filter(x=>x.id&&x.name).sort((a,b)=>a.name.localeCompare(b.name)));
    } catch(error) {
      res.status(error.status||502).json({error:error.message});
    }
  });

    router.post('/products/match-local', requireDb, async (req, res) => {
    res.set('Cache-Control','no-store');
    const body=req.body||{};
    const identifiers=[
      body.product_code,
      body.sku,
      body.supplier_sku
    ].map(v=>String(v||'').trim()).filter(Boolean);
    const normalized=identifiers.map(v=>v.toUpperCase().replace(/[^A-Z0-9-]/g,''));
    const digits=identifiers.map(v=>v.replace(/\D/g,'')).filter(Boolean);
    const name=String(body.name||'').trim();
    const description=String(body.description||'').trim();
    const supplierId=body.supplier_id||null;

    const exactResult=await pool.query(`
      SELECT DISTINCT
        p.id AS local_id,p.lightspeed_product_id,p.name,p.sku,p.upc,p.description,p.brand,
        sp.supplier_id,sp.supplier_sku,sp.supplier_description,sp.manufacturer_text,sp.supply_price,
        s.name AS supplier_name
      FROM products p
      LEFT JOIN product_identifiers pi ON pi.product_id=p.id
      LEFT JOIN supplier_products sp
        ON sp.product_id=p.id
       AND ($1::bigint IS NULL OR sp.supplier_id=$1::bigint)
      LEFT JOIN suppliers s ON s.id=sp.supplier_id
      WHERE
        (cardinality($2::text[])>0 AND lower(coalesce(p.sku,'')) = ANY(
          SELECT lower(x) FROM unnest($2::text[]) x
        ))
        OR (cardinality($3::text[])>0 AND regexp_replace(coalesce(p.upc,''),'\\D','','g') = ANY($3::text[]))
        OR (cardinality($4::text[])>0 AND pi.normalized_value = ANY($4::text[]))
        OR (cardinality($2::text[])>0 AND lower(coalesce(sp.supplier_sku,'')) = ANY(
          SELECT lower(x) FROM unnest($2::text[]) x
        ))
      LIMIT 25
    `,[supplierId,identifiers,digits,normalized]);

    if(exactResult.rows.length){
      return res.json({stage:'exact',matches:exactResult.rows.map(x=>({...x,score:100,reasons:['exact identifier']}))});
    }

    const fuzzyQueries=[name,description].filter(Boolean);
    const queryText=fuzzyQueries.join(' ').trim();
    if(!queryText)return res.json({stage:'local',matches:[]});

    const tokens=matchTokens(queryText).slice(0,10);
    const patterns=tokens.map(t=>`%${t}%`);
    const fuzzyResult=await pool.query(`
      SELECT DISTINCT
        p.id AS local_id,p.lightspeed_product_id,p.name,p.sku,p.upc,p.description,p.brand,
        sp.supplier_id,sp.supplier_sku,sp.supplier_description,sp.manufacturer_text,sp.supply_price,
        s.name AS supplier_name
      FROM products p
      LEFT JOIN supplier_products sp
        ON sp.product_id=p.id
       AND ($1::bigint IS NULL OR sp.supplier_id=$1::bigint)
      LEFT JOIN suppliers s ON s.id=sp.supplier_id
      WHERE
        lower(p.name) LIKE lower($2)
        OR lower(coalesce(p.description,'')) LIKE lower($2)
        OR lower(coalesce(sp.supplier_description,'')) LIKE lower($2)
        OR EXISTS (
          SELECT 1 FROM unnest($3::text[]) pat
          WHERE lower(p.name) LIKE pat
             OR lower(coalesce(p.description,'')) LIKE pat
             OR lower(coalesce(sp.supplier_description,'')) LIKE pat
             OR lower(coalesce(p.brand,'')) LIKE pat
             OR lower(coalesce(sp.manufacturer_text,'')) LIKE pat
        )
      LIMIT 120
    `,[supplierId,`%${name||queryText}%`,patterns]);

    const scored=fuzzyResult.rows
      .map(row=>({...row,...scorePotentialMatch(queryText,row)}))
      .filter(row=>row.score>=18)
      .sort((a,b)=>b.score-a.score||String(a.name).localeCompare(String(b.name)))
      .slice(0,25);

    res.json({stage:'local',matches:scored});
  });

  router.post('/products/match-remote', async (req, res) => {
    res.set('Cache-Control','no-store');
    const body=req.body||{};
    const identifiers=[
      body.product_code,
      body.sku,
      body.supplier_sku
    ].map(v=>String(v||'').trim()).filter(Boolean);
    const name=String(body.name||'').trim();
    const requests=[];

    const primaryIdentifier=identifiers[0]||null;
    if(primaryIdentifier){
      requests.push(
        lightspeedVersionedFetch(
          lightspeedDomain,
          lightspeedToken,
          '/products?sku='+encodeURIComponent(primaryIdentifier.toLowerCase()),
          {},
          '2026-07'
        )
      );
    }
    if(name){
      requests.push(
        lightspeedVersionedFetch(
          lightspeedDomain,
          lightspeedToken,
          '/products?name='+encodeURIComponent(name),
          {},
          '2026-07'
        )
      );
    }

    const results=await Promise.allSettled(requests);
    const seen=new Set();
    const matches=[];
    for(const result of results){
      if(result.status!=='fulfilled')continue;
      const rows=Array.isArray(result.value?.data)?result.value.data:[];
      for(const p of rows){
        if(!p?.id||seen.has(p.id))continue;
        seen.add(p.id);
        matches.push({...p,source:'lightspeed'});
        if(matches.length>=25)break;
      }
      if(matches.length>=25)break;
    }
    res.json({stage:'remote',matches});
  });

  router.get('/products/potential-matches', requireDb, async (req, res) => {
    res.set('Cache-Control','no-store');
    const q = String(req.query.q || '').trim();
    const supplierId = req.query.supplier_id || null;
    if (!q) return res.json([]);

    // Pull a broad candidate pool, then score in application code. This avoids exact-code dependence.
    const tokens = matchTokens(q).slice(0, 8);
    const patterns = tokens.map(t => `%${t}%`);
    const params = [supplierId, q, `%${q}%`, patterns];
    const result = await pool.query(`
      SELECT DISTINCT
        p.id AS local_id, p.lightspeed_product_id, p.name, p.sku, p.upc, p.description, p.brand,
        sp.id AS supplier_product_id, sp.supplier_id, sp.supplier_sku,
        sp.supplier_description, sp.manufacturer_text, sp.supply_price,
        s.name AS supplier_name
      FROM products p
      LEFT JOIN supplier_products sp
        ON sp.product_id=p.id
       AND ($1::bigint IS NULL OR sp.supplier_id=$1::bigint)
      LEFT JOIN suppliers s ON s.id=sp.supplier_id
      LEFT JOIN product_identifiers pi ON pi.product_id=p.id
      WHERE
        lower(coalesce(p.sku,''))=lower($2)
        OR p.upc=$2
        OR lower(coalesce(sp.supplier_sku,''))=lower($2)
        OR pi.normalized_value=upper(regexp_replace($2,'[^A-Za-z0-9-]','','g'))
        OR pi.normalized_value=regexp_replace($2,'\\D','','g')
        OR lower(p.name) LIKE lower($3)
        OR lower(coalesce(p.description,'')) LIKE lower($3)
        OR lower(coalesce(sp.supplier_description,'')) LIKE lower($3)
        OR EXISTS (
          SELECT 1 FROM unnest($4::text[]) pat
          WHERE lower(p.name) LIKE pat
             OR lower(coalesce(p.description,'')) LIKE pat
             OR lower(coalesce(sp.supplier_description,'')) LIKE pat
             OR lower(coalesce(p.brand,'')) LIKE pat
             OR lower(coalesce(sp.manufacturer_text,'')) LIKE pat
        )
      LIMIT 150
    `, params);

    const scored = result.rows
      .map(row => ({ ...row, ...scorePotentialMatch(q, row) }))
      .filter(row => row.score >= 18)
      .sort((a,b) => b.score - a.score || String(a.name).localeCompare(String(b.name)))
      .slice(0, 25);

    res.json(scored);
  });

  router.get('/products/exact', async (req, res) => {
    res.set('Cache-Control','no-store');
    const q = String(req.query.q || '').trim();
    if (!q) return res.json(null);

    const normalizedCode = q.toUpperCase().replace(/[^A-Z0-9-]/g, '');
    const digits = q.replace(/\D/g, '');

    if (pool) {
      const local = await pool.query(`
        SELECT DISTINCT p.*
        FROM products p
        LEFT JOIN product_identifiers pi ON pi.product_id=p.id
        LEFT JOIN supplier_products sp ON sp.product_id=p.id
        WHERE lower(coalesce(p.sku,''))=lower($1)
           OR ($2 <> '' AND regexp_replace(coalesce(p.upc,''),'\\D','','g')=$2)
           OR ($3 <> '' AND pi.normalized_value=$3)
           OR ($2 <> '' AND pi.normalized_value=$2)
           OR lower(coalesce(sp.supplier_sku,''))=lower($1)
        ORDER BY p.updated_at DESC
        LIMIT 1
      `, [q, digits, normalizedCode]);
      if (local.rows[0]) {
        const p = local.rows[0];
        return res.json({ ...p, local_id:p.id, source:'local' });
      }
    }

    try {
      const skuResult = await lightspeedVersionedFetch(
        lightspeedDomain,
        lightspeedToken,
        '/products?sku=' + encodeURIComponent(q.toLowerCase()),
        {},
        '2026-07'
      );
      const products = Array.isArray(skuResult?.data) ? skuResult.data : [];
      const exact = products.find(p =>
        String(p.sku || '').toLowerCase() === q.toLowerCase() ||
        String(p.upc || '').replace(/\D/g,'') === digits ||
        (Array.isArray(p.product_codes) && p.product_codes.some(code => {
          const value=String(code?.code || code?.value || '');
          return value.toLowerCase()===q.toLowerCase() || value.replace(/\D/g,'')===digits;
        }))
      ) || products[0] || null;

      if (exact) {
        const localProduct = await upsertLocalProduct(exact);
        return res.json({ ...exact, local_id:localProduct?.id || null, source:'lightspeed' });
      }

      const searchResult = await lightspeedVersionedFetch(
        lightspeedDomain,
        lightspeedToken,
        '/search?type=products&sku=' + encodeURIComponent(q.toLowerCase()) + '&page_size=20',
        {},
        '2026-07'
      );
      const searched = Array.isArray(searchResult?.data) ? searchResult.data : [];
      const searchedExact = searched.find(p => {
        const sku = String(p?.sku || '').trim();
        const upc = String(p?.upc || '').replace(/\D/g,'');
        const codes = Array.isArray(p?.product_codes) ? p.product_codes : [];
        return sku.toLowerCase() === q.toLowerCase() ||
          (digits !== '' && upc === digits) ||
          codes.some(code => {
            const value = String(code?.code || code?.value || '').trim();
            return value.toLowerCase() === q.toLowerCase() ||
              (digits !== '' && value.replace(/\D/g,'') === digits);
          });
      });
      if (searchedExact) {
        const localProduct = await upsertLocalProduct(searchedExact);
        return res.json({ ...searchedExact, local_id:localProduct?.id || null, source:'lightspeed' });
      }
    } catch (error) {
      console.warn('[special-orders] exact product lookup warning:', error.message);
    }

    res.json(null);
  });

  router.get('/products/search', async (req, res) => {
    res.set('Cache-Control','no-store');
    const q = String(req.query.q || '').trim();
    if (!q) return res.json([]);

    const normalizedCode = q.toUpperCase().replace(/[^A-Z0-9-]/g, '');
    const digits = q.replace(/\D/g, '');
    let local = [];

    if (pool) {
      const localResult = await pool.query(`
        SELECT DISTINCT p.*,
          CASE
            WHEN lower(coalesce(p.sku,''))=lower($1) THEN 0
            WHEN ($3 <> '' AND regexp_replace(coalesce(p.upc,''),'\\D','','g')=$3) THEN 0
            WHEN (($4 <> '' AND pi.normalized_value=$4) OR ($3 <> '' AND pi.normalized_value=$3)) THEN 0
            WHEN lower(coalesce(sp.supplier_sku,''))=lower($1) THEN 0
            WHEN lower(p.name)=lower($1) THEN 1
            ELSE 2
          END AS rank
        FROM products p
        LEFT JOIN product_identifiers pi ON pi.product_id=p.id
        LEFT JOIN supplier_products sp ON sp.product_id=p.id
        WHERE lower(coalesce(p.sku,''))=lower($1)
           OR ($3 <> '' AND regexp_replace(coalesce(p.upc,''),'\\D','','g')=$3)
           OR ($4 <> '' AND pi.normalized_value=$4)
           OR ($3 <> '' AND pi.normalized_value=$3)
           OR lower(coalesce(sp.supplier_sku,''))=lower($1)
           OR lower(p.name) LIKE lower($2)
           OR lower(coalesce(p.description,'')) LIKE lower($2)
        ORDER BY rank,p.name
        LIMIT 25
      `, [q, `%${q}%`, digits, normalizedCode]);
      local = localResult.rows.map(p => ({ ...p, local_id:p.id, source:'local' }));
    }

    const seen = new Set(local.map(p => p.lightspeed_product_id).filter(Boolean));
    const remote = [];

    try {
      const requests = [
        lightspeedVersionedFetch(
          lightspeedDomain,
          lightspeedToken,
          '/products?sku=' + encodeURIComponent(q.toLowerCase()),
          {},
          '2026-07'
        ),
        lightspeedVersionedFetch(
          lightspeedDomain,
          lightspeedToken,
          '/products?name=' + encodeURIComponent(q),
          {},
          '2026-07'
        ),
        lightspeedVersionedFetch(
          lightspeedDomain,
          lightspeedToken,
          '/search?type=products&sku=' + encodeURIComponent(q.toLowerCase()) + '&page_size=20',
          {},
          '2026-07'
        )
      ];

      const results = await Promise.allSettled(requests);
      for (const result of results) {
        if (result.status !== 'fulfilled') continue;
        for (const product of (Array.isArray(result.value?.data) ? result.value.data : [])) {
          if (!product?.id || seen.has(product.id)) continue;
          seen.add(product.id);
          const localProduct = await upsertLocalProduct(product);
          remote.push({ ...product, local_id:localProduct?.id || null, source:'lightspeed' });
        }
      }
    } catch (error) {
      if (local.length === 0) return res.status(502).json({ error:error.message });
    }

    res.json([...local,...remote].slice(0,25));
  });

  router.patch('/items/:id/link-product', requireDb, async (req, res) => {
    const productId = req.body?.product_id;
    if (!productId) return res.status(400).json({ error:'product_id is required.' });
    const product = await pool.query('SELECT * FROM products WHERE id=$1', [productId]);
    if (!product.rows[0]) return res.status(404).json({ error:'Product not found.' });
    const updated = await pool.query(`
      UPDATE special_order_items
      SET product_id=$1, placeholder_product=false, product_data_status='COMPLETE', updated_at=now()
      WHERE id=$2 RETURNING *
    `, [productId, req.params.id]);
    if (!updated.rows[0]) return res.status(404).json({ error:'Special-order item not found.' });
    await pool.query(`
      UPDATE supplier_order_items
      SET product_id=$1, placeholder_name=NULL, placeholder_sku=NULL
      WHERE special_order_item_id=$2 AND product_id IS NULL
    `, [productId, req.params.id]);
    res.json(updated.rows[0]);
  });

  router.post('/products/create-lightspeed', async (req, res) => {
    if (!allowProductWrites && !liveMode) {
      return res.status(423).json({ error:'Lightspeed product creation is disabled. Enable product-write testing or live mode.' });
    }
    const body = req.body || {};
    const missing = [];
    if (!body.name) missing.push('name');
    if (!body.sku) missing.push('sku');
    if (body.supply_price === undefined || body.supply_price === null) missing.push('supply_price');
    if (!body.product_category_id && !body.product_type_id) missing.push('product_category_id');
    if (body.price_including_tax === undefined && body.price_excluding_tax === undefined) missing.push('price');
    if (missing.length) return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });

    try {
      if (pool) {
        const codes = (Array.isArray(body.product_codes) ? body.product_codes : [])
          .map(x => String(x?.code || '').trim()).filter(Boolean);
        const normalizedCodes = codes.map(x => x.toUpperCase().replace(/[^A-Z0-9-]/g,''));
        const digitCodes = codes.map(x => x.replace(/\D/g,'')).filter(Boolean);
        const duplicate = await pool.query(`
          SELECT DISTINCT p.id AS local_id,p.lightspeed_product_id,p.name,p.sku,p.upc
          FROM products p
          LEFT JOIN product_identifiers pi ON pi.product_id=p.id
          LEFT JOIN supplier_products sp ON sp.product_id=p.id
          WHERE lower(coalesce(p.sku,''))=lower($1)
             OR lower(coalesce(sp.supplier_sku,''))=lower($2)
             OR ($3::text[] <> '{}'::text[] AND pi.normalized_value = ANY($3::text[]))
             OR ($4::text[] <> '{}'::text[] AND regexp_replace(coalesce(p.upc,''),'\\D','','g') = ANY($4::text[]))
          LIMIT 10
        `, [String(body.sku||''),String(body.supplier_sku||''),normalizedCodes,digitCodes]);
        if (duplicate.rows.length) {
          return res.status(409).json({
            error:'An existing product already matches this SKU, supplier code, or product code.',
            matches:duplicate.rows
          });
        }
      }

      // Hobby Corner's Lightspeed account is tax-exclusive. Normalize stale/older
      // clients that may still submit price_including_tax.
      if (body.price_excluding_tax === undefined && body.price_including_tax !== undefined) {
        body.price_excluding_tax = body.price_including_tax;
      }
      delete body.price_including_tax;

      if (body.local_supplier_id) {
        const supplierResult=await pool.query(
          'SELECT id,name,lightspeed_supplier_id FROM suppliers WHERE id=$1',
          [body.local_supplier_id]
        );
        const supplier=supplierResult.rows[0];
        let lightspeedSupplierId=supplier?.lightspeed_supplier_id || null;
        if (!lightspeedSupplierId && supplier?.name) {
          try {
            const listed=await lightspeedVersionedFetch(
              lightspeedDomain,lightspeedToken,'/suppliers?page_size=1000',{},'2026-04'
            );
            const rows=Array.isArray(listed?.data)?listed.data:(Array.isArray(listed)?listed:[]);
            const exact=rows.find(x=>String(x?.name||'').trim().toLowerCase()===supplier.name.trim().toLowerCase());
            if (exact?.id) {
              lightspeedSupplierId=exact.id;
              await pool.query(
                'UPDATE suppliers SET lightspeed_supplier_id=$1,updated_at=now() WHERE id=$2',
                [exact.id,supplier.id]
              );
            }
          } catch(error) {
            console.warn('[special-orders] supplier Lightspeed ID lookup warning:',error.message);
          }
        }
        if (lightspeedSupplierId) {
          body.supplier_id=lightspeedSupplierId;
          if (body.supplier_sku) body.supplier_code=body.supplier_sku;
        }
      }

      const allowed = [
        'name','description','sku','product_codes','is_active','price_excluding_tax',
        'supply_price','supplier_id','supplier_code','product_suppliers','product_type_id','product_category_id',
        'brand_id','tag_ids','inventory','weight','weight_unit','length','width','height','dimensions_unit'
      ];
      const payload = {};
      for (const key of allowed) if (body[key] !== undefined) payload[key] = body[key];

      // Every product created through Special Orders is tagged so it can be audited/enriched later.
      const soTagId = await ensureLightspeedTag(lightspeedDomain, lightspeedToken, 'Added by SO');
      payload.tag_ids = Array.from(new Set([...(Array.isArray(payload.tag_ids) ? payload.tag_ids : []), soTagId]));

      const result = await lightspeedFetch(lightspeedDomain, lightspeedToken, '/products', {
        method: 'POST', body: JSON.stringify(payload)
      });
      const product = result?.data || result;
      const localProduct = await upsertLocalProduct(product);
      if (localProduct && body.reorder_setup_needed !== undefined) {
        await pool.query(
          'UPDATE products SET reorder_setup_needed=$1,updated_at=now() WHERE id=$2',
          [Boolean(body.reorder_setup_needed),localProduct.id]
        );
      }

      const extraIdentifiers = [];
      for (const code of (Array.isArray(body.product_codes) ? body.product_codes : [])) {
        if (code?.code) extraIdentifiers.push({
          type:String(code.type || 'OTHER').toUpperCase(),
          value:code.code,
          source:'special-order-create'
        });
      }
      if (body.isbn && !extraIdentifiers.some(x => x.type==='ISBN' && x.value===body.isbn)) {
        extraIdentifiers.push({ type:'ISBN', value:body.isbn, source:'special-order-create' });
      }
      for (const value of (Array.isArray(body.other_codes) ? body.other_codes : [])) {
        if (value) extraIdentifiers.push({ type:'OTHER', value, source:'special-order-create' });
      }
      if (extraIdentifiers.length) await upsertProductIdentifiers(pool, localProduct.id, extraIdentifiers, 'special-order-create');

      const localSupplierIds = Array.from(new Set(
        (Array.isArray(body.local_supplier_ids) ? body.local_supplier_ids : [])
          .concat(body.local_supplier_id ? [body.local_supplier_id] : [])
          .filter(Boolean)
      ));
      let localPriority = 1;
      for (const supplierId of localSupplierIds) {
        await pool.query(`
          INSERT INTO supplier_products
            (supplier_id,product_id,supplier_sku,supplier_description,manufacturer_text,
             order_channel,order_url,supply_price,priority,is_orderable,notes)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,$10)
          ON CONFLICT (supplier_id,product_id) DO UPDATE SET
            supplier_sku=COALESCE(EXCLUDED.supplier_sku,supplier_products.supplier_sku),
            supplier_description=COALESCE(EXCLUDED.supplier_description,supplier_products.supplier_description),
            manufacturer_text=COALESCE(EXCLUDED.manufacturer_text,supplier_products.manufacturer_text),
            order_channel=EXCLUDED.order_channel,
            order_url=COALESCE(EXCLUDED.order_url,supplier_products.order_url),
            supply_price=COALESCE(EXCLUDED.supply_price,supplier_products.supply_price),
            priority=LEAST(supplier_products.priority,EXCLUDED.priority)
        `, [
          supplierId,localProduct.id,body.supplier_sku||null,body.supplier_description||body.description||null,
          body.manufacturer_text||null,String(body.order_channel||'TRADE').toUpperCase(),
          body.source_url||null,body.supply_price??null,localPriority++,body.supplier_notes||null
        ]);
      }

      let image = null;
      let imageWarning = null;
      if (body.image_url) {
        try {
          image = await uploadLightspeedImageFromUrl(lightspeedDomain, lightspeedToken, product.id, body.image_url);
        } catch (imageError) {
          imageWarning = imageError.message;
        }
      }
      console.log('[special-orders] Lightspeed product created', {
        id:product?.id || null,
        sku:product?.sku || body.sku || null,
        name:product?.name || body.name || null
      });
      res.status(201).json({
        lightspeed: product,
        local: localProduct,
        tag: 'Added by SO',
        image,
        image_warning: imageWarning,
        identifiers: extraIdentifiers,
        local_supplier_ids: localSupplierIds
      });
    } catch (error) {
      console.error('[special-orders] Lightspeed product create failed', {
        status:error.status || 502,
        message:error.message,
        sku:req.body?.sku || null,
        product_codes:req.body?.product_codes || []
      });
      res.status(error.status || 502).json({
        error:error.message,
        lightspeed_status:error.status || null
      });
    }
  });

}
