import express from 'express';
import cors from 'cors';
import PDFDocument from 'pdfkit';
import bwipjs from 'bwip-js';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();

app.use(cors());
app.use(express.json());

// Serve the Label Maker UI from the root directory
app.get('/index.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const LIGHTSPEED_DOMAIN = process.env.LIGHTSPEED_DOMAIN;
const LIGHTSPEED_TOKEN = process.env.LIGHTSPEED_TOKEN;

// Health-check route
app.get('/', (req, res) => {
  res.send('Lightspeed Avery Label API is running.');
});




async function generatePoPdf(req, res) {
  try {
    const { poId } = req.params;

    if (!LIGHTSPEED_DOMAIN || !LIGHTSPEED_TOKEN) {
      return res.status(500).send('Server configuration missing: LIGHTSPEED_DOMAIN or LIGHTSPEED_TOKEN.');
    }

    // 1. Fetch Purchase Order line items from Lightspeed
    const poResponse = await fetch(`https://${LIGHTSPEED_DOMAIN}.retail.lightspeed.app/api/2.0/consignments/${poId}/products`, {
      headers: { 
        'Authorization': `Bearer ${LIGHTSPEED_TOKEN}`,
        'User-Agent': 'HobbyCorner-Averys/1.0',
        'Accept': 'application/json'
      }
    });

    if (!poResponse.ok) {
      const errorText = await poResponse.text();
      const safeToken = LIGHTSPEED_TOKEN ? LIGHTSPEED_TOKEN.substring(0, 5) + '...' : 'MISSING';
      
      return res.status(500).send(`
        <div style="font-family: sans-serif; padding: 20px;">
          <h2 style="color: red;">Lightspeed Blocked the Request (${poResponse.status})</h2>
          <p><b>Lightspeed's Exact Error:</b> ${errorText}</p>
          <p><b>Token Being Used:</b> ${safeToken}</p>
          <p><b>Requested URL:</b> https://${LIGHTSPEED_DOMAIN}.retail.lightspeed.app/api/2.0/consignments/${poId}/products</p>
        </div>
      `);
    }

    const poData = await poResponse.json();
    const lineItems = poData.data || [];

    // 2. Initialize PDF Document
    const doc = new PDFDocument({
      size: 'letter',
      margins: { top: 36, bottom: 36, left: 13.5, right: 13.5 }, 
      autoFirstPage: true
    });

    // 3. Configure response headers
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="PO_${poId}_Avery_5960.pdf"`);
    doc.pipe(res);

    let Count = 0;

    // 4. Process line items
    for (const item of lineItems) {
      const qty = item.received || item.count || 1;

      // Fetch individual product details
      const prodResponse = await fetch(`https://${LIGHTSPEED_DOMAIN}.retail.lightspeed.app/api/2.0/products/${item.product_id}`, {
        headers: { 
          'Authorization': `Bearer ${LIGHTSPEED_TOKEN}`,
          'User-Agent': 'HobbyCorner-Averys/1.0',
          'Accept': 'application/json'
        }
      });

      let product = {};
      if (prodResponse.ok) {
        const prodData = await prodResponse.json();
        product = prodData.data || {};
      }

      const valuesMap = {
        name: product.name || 'Unknown Product',
        sku: product.sku || 'UNKNOWN',
        price: product.price_including_tax ? `$${product.price_including_tax}` : '$0.00'
      };

      // Generate barcode buffer
      let barcodeBuffer = null;
      if (valuesMap.sku !== 'UNKNOWN') {
        try {
          barcodeBuffer = await bwipjs.toBuffer({
            bcid: 'code128',
            text: valuesMap.sku,
            scale: 3,
            height: 10,
            includetext: false
          });
        } catch (barcodeErr) {
          console.error(`Barcode generation failed for SKU ${valuesMap.sku}:`, barcodeErr);
        }
      }

      // 5. Draw  copies matching received quantity
      for (let i = 0; i < qty; i++) {
        if (Count > 0 && Count % 30 === 0) {
          doc.addPage();
        }

        const positionOnPage = Count % 30;
        const col = positionOnPage % 3;             
        const row = Math.floor(positionOnPage / 3);   

        const originX = 13.5 + (col * 198);
        const originY = 36 + (row * 72);

        for (const el of Template.elements) {
          const val = valuesMap[el.field] || '';

          if (el.type === 'text') {
            doc.fontSize(el.fontSize || 8)
               .font(el.bold ? 'Helvetica-Bold' : 'Helvetica')
               .text(val, originX + el.x, originY + el.y, {
                 width: el.maxWidth || undefined,
                 align: el.align || 'left',
                 lineBreak: false,
                 ellipsis: true
               });
          } else if (el.type === 'barcode' && barcodeBuffer) {
            doc.image(barcodeBuffer, originX + el.x, originY + el.y, {
              width: el.width,
              height: el.height
            });
          }
        }
        Count++;
      }
    }

    // 6. Finish stream
    doc.end();

  } catch (error) {
    console.error('Fatal PDF Generation Error:', error);
    if (!res.headersSent) {
      res.status(500).send(`
        <div style="font-family: sans-serif; padding: 20px;">
          <h2 style="color: red;">The Server Crashed!</h2>
          <p><b>Error Message:</b> ${error.message}</p>
          <p><b>Stack Trace:</b> <pre>${error.stack}</pre></p>
        </div>
      `);
    }
  }
}

// Routes must be placed before app.listen!
app.get('/api/labels/po/:poId', generatePoPdf);
app.get('/api/labels/po/:poId/pdf', generatePoPdf);


///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

// Route to fetch PO data and automatically match open customer special orders
app.get('/api/po/:poId/data', async (req, res) => {
  try {
    const { poId } = req.params;
    
    // 1. Fetch the PO line items
    const poResponse = await fetch(`https://${LIGHTSPEED_DOMAIN}.retail.lightspeed.app/api/2.0/consignments/${poId}/products`, {
      headers: { 'Authorization': `Bearer ${LIGHTSPEED_TOKEN}`, 'User-Agent': 'HobbyCorner-AveryLabels/1.0', 'Accept': 'application/json' }
    });
    
    if (!poResponse.ok) throw new Error('Failed to fetch PO from Lightspeed');
    const poData = await poResponse.json();
    const lineItems = poData.data || [];

    // 2. Fetch all active sales and COMBINE Gross Qty by Product ID per Order
    let saleProductMap = {}; // Structure: { saleId: { productId: { grossQty, customerName } } }
    let customerCache = {}; 
    let processedSaleIds = new Set(); 

    try {
      const endpointsToFetch = [
        // We removed OPEN and SAVED so parked/abandoned register sales are ignored!
        `https://${LIGHTSPEED_DOMAIN}.retail.lightspeed.app/api/2.0/sales?status=LAYBY&page_size=500`,
        `https://${LIGHTSPEED_DOMAIN}.retail.lightspeed.app/api/2.0/sales?status=ONACCOUNT&page_size=500`,
        `https://${LIGHTSPEED_DOMAIN}.retail.lightspeed.app/api/2.0/sales?status=AWAITING_PICKUP&page_size=500`,
        `https://${LIGHTSPEED_DOMAIN}.retail.lightspeed.app/api/2.0/sales?status=AWAITING_DISPATCH&page_size=500`,
        `https://${LIGHTSPEED_DOMAIN}.retail.lightspeed.app/api/2.0/sales?fulfillment_status=NEW&page_size=500`,
        `https://${LIGHTSPEED_DOMAIN}.retail.lightspeed.app/api/2.0/sales?fulfillment_status=STARTED&page_size=500`,
        `https://${LIGHTSPEED_DOMAIN}.retail.lightspeed.app/api/2.0/sales?fulfillment_status=UNFULFILLED&page_size=500`
      ];
      
      for (const url of endpointsToFetch) {
        const ordersResponse = await fetch(url, {
          headers: { 'Authorization': `Bearer ${LIGHTSPEED_TOKEN}`, 'User-Agent': 'HobbyCorner-AveryLabels/1.0', 'Accept': 'application/json' }
        });
        
        if (ordersResponse.ok) {
          const ordersData = await ordersResponse.json();
          
          for (const sale of (ordersData.data || [])) {
            if (processedSaleIds.has(sale.id)) continue;
            processedSaleIds.add(sale.id);

            const saleStatus = (sale.status || '').toUpperCase();
            
            if (['PICKED_UP_CLOSED', 'DISPATCHED_CLOSED', 'RETURN', 'VOIDED', 'COMPLETED'].includes(saleStatus)) {
              continue; 
            }

            if (saleStatus === 'CLOSED') {
              const saleFulfillment = (sale.fulfillment_status || '').toUpperCase();
              if (!saleFulfillment || ['FULFILLED', 'COMPLETED', 'DELIVERED', 'SHIPPED', 'DISPATCHED', 'PICKED_UP'].includes(saleFulfillment)) {
                continue;
              }
            }

            let customerName = 'Special Order';
            if (sale.customer_id) {
              if (!customerCache[sale.customer_id]) {
                try {
                  const custRes = await fetch(`https://${LIGHTSPEED_DOMAIN}.retail.lightspeed.app/api/2.0/customers/${sale.customer_id}`, {
                    headers: { 'Authorization': `Bearer ${LIGHTSPEED_TOKEN}`, 'User-Agent': 'HobbyCorner-AveryLabels/1.0', 'Accept': 'application/json' }
                  });
                  if (custRes.ok) {
                    const custData = await custRes.json();
                    const cust = custData.data || {};
                    customerCache[sale.customer_id] = `${cust.first_name || ''} ${cust.last_name || ''}`.trim() || cust.company_name || 'Special Order';
                  } else {
                    customerCache[sale.customer_id] = 'Special Order';
                  }
                } catch (e) {
                  customerCache[sale.customer_id] = 'Special Order';
                }
              }
              customerName = customerCache[sale.customer_id];
            }

            // Initialize this sale in our map
            if (!saleProductMap[sale.id]) saleProductMap[sale.id] = {};

            for (const line of (sale.line_items || [])) {
              const totalQty = parseFloat(line.quantity || line.unit_quantity) || 1;
              if (totalQty <= 0) continue; 
              
              const pId = line.product_id;
              
              // FIX: Add matching products on the same receipt together!
              if (!saleProductMap[sale.id][pId]) {
                saleProductMap[sale.id][pId] = { grossQty: 0, customerName: customerName };
              }
              saleProductMap[sale.id][pId].grossQty += totalQty;
            }
          }
        }
      }
    } catch (orderErr) {
      console.log('Could not fetch open sales orders:', orderErr.message);
    }

    // 3. FETCH FULFILLMENTS and COMBINE Packed Qty by Product ID per Order
    let fulfillmentProductMap = {}; // Structure: { saleId: { productId: packedQty } }
    const saleIdArray = Array.from(processedSaleIds);
    let processedFulfillments = new Set(); 

    try {
      const fulfillmentPromises = saleIdArray.map(async (saleId) => {
        try {
          const res = await fetch(`https://${LIGHTSPEED_DOMAIN}.retail.lightspeed.app/api/2.0/fulfillments?sale_id=${saleId}`, {
            headers: { 'Authorization': `Bearer ${LIGHTSPEED_TOKEN}`, 'User-Agent': 'HobbyCorner-AveryLabels/1.0', 'Accept': 'application/json' }
          });
          if (res.ok) {
            const data = await res.json();
            return data.data || [];
          }
        } catch (e) {
          return [];
        }
        return [];
      });

      const allFulfillmentsArrays = await Promise.all(fulfillmentPromises);
      
      for (const fulfillments of allFulfillmentsArrays) {
        for (const f of fulfillments) {
           if (processedFulfillments.has(f.id)) continue;
           processedFulfillments.add(f.id);

           const saleId = f.sale_id;
           if (!fulfillmentProductMap[saleId]) fulfillmentProductMap[saleId] = {};

           for (const fLine of (f.line_items || [])) {
             const pId = fLine.product_id;
             if (pId) {
               const doneQty = Math.max(
                 parseFloat(fLine.picked_quantity || 0),
                 parseFloat(fLine.packed_quantity || 0),
                 parseFloat(fLine.fulfilled_quantity || 0)
               );
               
               // FIX: Add matching products on the same fulfillment together!
               fulfillmentProductMap[saleId][pId] = (fulfillmentProductMap[saleId][pId] || 0) + doneQty;
             }
           }
        }
      }
    } catch (err) {
      console.log('Error fetching targeted fulfillments:', err.message);
    }

    // 4. Calculate Net Required per Product (Gross minus Packed)
    let productMathMap = {};
    
    for (const saleId in saleProductMap) {
      for (const productId in saleProductMap[saleId]) {
        const itemData = saleProductMap[saleId][productId];
        const grossQty = itemData.grossQty;
        
        // Find the packed amount for this specific order/product combo (if it exists)
        const packedQty = (fulfillmentProductMap[saleId] && fulfillmentProductMap[saleId][productId]) 
                          ? fulfillmentProductMap[saleId][productId] 
                          : 0;
                          
        const netQty = Math.max(0, grossQty - packedQty);
        
        // Only tally it if we actually need a label for it!
        if (netQty > 0) {
          if (!productMathMap[productId]) {
            productMathMap[productId] = { netQty: 0, names: new Set() };
          }
          productMathMap[productId].netQty += netQty;
          productMathMap[productId].names.add(itemData.customerName);
        }
      }
    }

    // 5. Build Final Payload
    const enrichedItems = [];
    for (const item of lineItems) {
      const prodResponse = await fetch(`https://${LIGHTSPEED_DOMAIN}.retail.lightspeed.app/api/2.0/products/${item.product_id}`, {
        headers: { 'Authorization': `Bearer ${LIGHTSPEED_TOKEN}`, 'User-Agent': 'HobbyCorner-AveryLabels/1.0', 'Accept': 'application/json' }
      });
      
      let product = {};
      if (prodResponse.ok) {
        const prodData = await prodResponse.json();
        product = prodData.data || {};
      }

      const matchedOrder = productMathMap[item.product_id] || { netQty: 0, names: new Set() };
      
      const poQty = parseFloat(item.received || item.count || 1);
      const cappedSoQty = Math.min(poQty, matchedOrder.netQty);
      
      let finalNamesArray = Array.from(matchedOrder.names);
      if (finalNamesArray.some(n => n !== 'Special Order')) {
        finalNamesArray = finalNamesArray.filter(n => n !== 'Special Order');
      }

      enrichedItems.push({
        id: item.product_id,
        name: product.name || 'Unknown Product',
        sku: product.sku || 'UNKNOWN',
        price: product.price_including_tax ? `$${product.price_including_tax}` : '$0.00',
        qty: poQty,
        autoSoQty: cappedSoQty, 
        autoCustomerName: finalNamesArray.join(' & ')
      });
    }

    res.json(enrichedItems);

  } catch (error) {
    console.error('Data Fetch Error:', error);
    res.status(500).json({ error: error.message });
  }
});

////////////////////////////////////////////End of API/PO?:poId/Data ///////////////////////////////////////////////////////////////////////////////////////////////////////////
////////////////////////////

// Automatically ensure the templates directory and default files exist
async function ensureTemplatesExist() {
  const templatesDir = path.join(__dirname, 'templates');
  try {
    await fs.mkdir(templatesDir, { recursive: true });
    const files = await fs.readdir(templatesDir);
    
    // If the folder is empty, automatically write out the default templates
    if (files.length === 0) {
      const standardTemplate = {
        id: "avery_5960",
        name: "Avery 5960 (RMS Layout)",
        grid: { columns: 3, rows: 10, spacingX: 198, spacingY: 72 },
        elements: [
          { type: "text", field: "name", x: 7.5, y: 7.5, fontSize: 9, maxWidth: 175, align: "left" },
          { type: "text", field: "sku", x: 7.5, y: 20, fontSize: 8, maxWidth: 114, align: "left" },
          { type: "text", field: "price", x: 117.5, "y": 17.5, fontSize: 14, maxWidth: 65, align: "right" },
          { type: "barcode", field: "sku", x: 7.5, "y": 37.5, width: 112.5, height: 24 },
          { type: "text", field: "store", x: 125, y: 45, fontSize: 8, maxWidth: 50, align: "center" }
        ]
      };

      const specialTemplate = {
        id: "avery_5960_special",
        name: "Avery 5960 (Special Order)",
        grid: { columns: 3, rows: 10, spacingX: 198, spacingY: 72 },
        elements: [
          { type: "text", field: "specialTag", x: 5, y: 5, fontSize: 10, bold: true, align: "center", maxWidth: 179 },
          { type: "text", field: "customerName", x: 5, y: 17, fontSize: 14, bold: true, align: "center", maxWidth: 179 },
          { type: "barcode", field: "sku", x: 25, y: 34, width: 140, height: 20 },
          { type: "text", field: "name", x: 5, y: 57, fontSize: 6, maxWidth: 130, align: "left" },
          { type: "text", field: "price", x: 145, y: 57, fontSize: 8, bold: true },
          { type: "text", field: "sku", x: 25, y: 57, fontSize: 6, bold: false }
        ]
      };

      await fs.writeFile(path.join(templatesDir, 'avery_5960.json'), JSON.stringify(standardTemplate, null, 2));
      await fs.writeFile(path.join(templatesDir, 'avery_5960_special.json'), JSON.stringify(specialTemplate, null, 2));
      console.log('Default template files automatically created.');
    }
  } catch (err) {
    console.error('Error ensuring templates directory exists:', err);
  }
}

app.get('/api/templates', async (req, res) => {
  try {
    const templatesDir = path.join(__dirname, 'templates');
    const files = await fs.readdir(templatesDir);
    const templates = [];
    
    for (const file of files) {
      if (file.endsWith('.json') && !file.includes('_special')) {
        const fileData = await fs.readFile(path.join(templatesDir, file), 'utf-8');
        const json = JSON.parse(fileData);
        templates.push({ id: file.replace('.json', ''), name: json.name });
      }
    }
    res.json(templates);
  } catch (error) {
    console.error('Template Discovery Error:', error);
    // Send the actual error message to the browser so we can see it!
    res.status(500).json({ error: error.message, path: path.join(__dirname, 'templates') });
  }
});

app.post('/api/labels/generate', async (req, res) => {
  try {
    const { poId, startRow = 1, startCol = 1, templateId = 'avery_5960', customText = '', items = [] } = req.body;

    console.log(`\n--- GENERATING PDF FOR PO: ${poId} ---`);
    console.log(`Selected Template ID: ${templateId}`);

    // 1. Load the templates
    let labelTemplate, specialOrderTemplate;
    try {
      const standardData = await fs.readFile(path.join(__dirname, 'templates', `${templateId}.json`), 'utf-8');
      labelTemplate = JSON.parse(standardData);
      
      try {
        const specialData = await fs.readFile(path.join(__dirname, 'templates', `${templateId}_special.json`), 'utf-8');
        specialOrderTemplate = JSON.parse(specialData);
        console.log(`[SUCCESS] Loaded special template: ${templateId}_special.json`);
      } catch (err) {
        console.log(`[WARNING] Could not load ${templateId}_special.json. Falling back to standard template.`);
        specialOrderTemplate = labelTemplate;
      }
    } catch (error) {
      throw new Error(`Failed to load base template file: ${templateId}.json`);
    }

    // 2. Setup the PDF Document
    const doc = new PDFDocument({
      size: 'letter',
      margins: { top: 36, bottom: 36, left: 13.5, right: 13.5 },
      autoFirstPage: true
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="PO_${poId}_Labels.pdf"`);
    doc.pipe(res);

    const startOffset = Math.max(0, ((startRow - 1) * 3) + (startCol - 1));
    let labelCount = startOffset;

    // 3. Loop through items and draw labels
    for (const item of items) {
      let barcodeBuffer = null;
      if (item.sku && item.sku !== 'UNKNOWN') {
        try {
          barcodeBuffer = await bwipjs.toBuffer({ bcid: 'code128', text: item.sku, scale: 3, height: 10, includetext: false });
        } catch (err) {
          console.error(`Barcode error for SKU ${item.sku}:`, err);
        }
      }

      // Calculate the split quantities
      const soQty = Math.min(item.qty, item.soQty || 0);
      const normalQty = item.qty - soQty;
      
      console.log(`Item [${item.sku}]: Total Qty = ${item.qty}, Special Qty = ${soQty}, Normal Qty = ${normalQty}`);

      const valuesMap = {
        name: item.name || '',
        sku: item.sku || '',
        price: item.price || '$0.00',
        customerName: item.customerName || 'NO NAME PROVIDED',
        specialTag: '*** SPECIAL ORDER ***',
        store: customText
      };

      // Helper function to draw a single label slot
      const drawLabel = (template) => {
        if (labelCount > 0 && labelCount % 30 === 0) doc.addPage();
        
        const positionOnPage = labelCount % 30;
        const col = positionOnPage % 3;
        const row = Math.floor(positionOnPage / 3);
        
        const originX = 13.5 + (col * 198);
        const originY = 36 + (row * 72);

        for (const el of template.elements) {
          const val = valuesMap[el.field] || '';
          if (el.type === 'text') {
            doc.fontSize(el.fontSize || 8)
               .font(el.bold ? 'Helvetica-Bold' : 'Helvetica')
               .text(val, originX + el.x, originY + el.y, {
                 width: el.maxWidth || undefined, align: el.align || 'left', lineBreak: false, ellipsis: true
               });
          } else if (el.type === 'barcode' && barcodeBuffer) {
            doc.image(barcodeBuffer, originX + el.x, originY + el.y, { width: el.width, height: el.height });
          }
        }
        labelCount++;
      };

      // Draw Special Order labels first, then the remaining Normal labels
      for (let i = 0; i < soQty; i++) drawLabel(specialOrderTemplate);
      for (let i = 0; i < normalQty; i++) drawLabel(labelTemplate);
    }

    doc.end();
    console.log(`--- FINISHED PDF GENERATION ---\n`);
  } catch (error) {
    console.error('PDF Generation Error:', error);
    if (!res.headersSent) res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 8080;
ensureTemplatesExist().then(() => {
  app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
});
