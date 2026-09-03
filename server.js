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
        'User-Agent': 'HobbyCorner-AveryLabels/1.0',
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

    let labelCount = 0;

    // 4. Process line items
    for (const item of lineItems) {
      const qty = item.received || item.count || 1;

      // Fetch individual product details
      const prodResponse = await fetch(`https://${LIGHTSPEED_DOMAIN}.retail.lightspeed.app/api/2.0/products/${item.product_id}`, {
        headers: { 
          'Authorization': `Bearer ${LIGHTSPEED_TOKEN}`,
          'User-Agent': 'HobbyCorner-AveryLabels/1.0',
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

      // 5. Draw label copies matching received quantity
      for (let i = 0; i < qty; i++) {
        if (labelCount > 0 && labelCount % 30 === 0) {
          doc.addPage();
        }

        const positionOnPage = labelCount % 30;
        const col = positionOnPage % 3;             
        const row = Math.floor(positionOnPage / 3);   

        const originX = 13.5 + (col * 198);
        const originY = 36 + (row * 72);

        for (const el of labelTemplate.elements) {
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
        labelCount++;
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
('/api/labels/po/:poId', generatePoPdf);
('/api/labels/po/:poId/pdf', generatePoPdf);

// New route to send PO data to the UI Dashboard
// Updated route to fetch PO data AND automatically match open customer special orders
// Route to fetch PO data and automatically match open customer special orders
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

    // 2. Fetch open/unfulfilled customer orders from Lightspeed to match special orders
    let openOrdersMap = {};
    try {
      const ordersResponse = await fetch(`https://${LIGHTSPEED_DOMAIN}.retail.lightspeed.app/api/2.0/sales?status=OPEN`, {
        headers: { 'Authorization': `Bearer ${LIGHTSPEED_TOKEN}`, 'User-Agent': 'HobbyCorner-AveryLabels/1.0', 'Accept': 'application/json' }
      });
      if (ordersResponse.ok) {
        const ordersData = await ordersResponse.json();
        for (const sale of (ordersData.data || [])) {
          const customerName = sale.customer ? `${sale.customer.first_name || ''} ${sale.customer.last_name || ''}`.trim() : 'Special Order';
          for (const line of (sale.line_items || [])) {
            if (!openOrdersMap[line.product_id]) {
              openOrdersMap[line.product_id] = { qty: 0, names: [] };
            }
            openOrdersMap[line.product_id].qty += line.quantity || 1;
            openOrdersMap[line.product_id].names.push(customerName);
          }
        }
      }
    } catch (orderErr) {
      console.log('Could not fetch open sales orders, skipping auto-match:', orderErr.message);
    }

    // 3. Fetch individual product details and attach any automated special order data
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

      const matchedOrder = openOrdersMap[item.product_id] || { qty: 0, names: [] };

      enrichedItems.push({
        id: item.product_id,
        name: product.name || 'Unknown Product',
        sku: product.sku || 'UNKNOWN',
        price: product.price_including_tax ? `$${product.price_including_tax}` : '$0.00',
        qty: item.received || item.count || 1,
        autoSoQty: matchedOrder.qty,
        autoCustomerName: matchedOrder.names.join(', ')
      });
    }

    res.json(enrichedItems);

  } catch (error) {
    console.error('Data Fetch Error:', error);
    res.status(500).json({ error: error.message });
  }
});

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

    // Load the selected templates from the folder dynamically
    let labelTemplate, specialOrderTemplate;
    try {
      const standardData = await fs.readFile(path.join(__dirname, 'templates', `${templateId}.json`), 'utf-8');
      labelTemplate = JSON.parse(standardData);
      
      try {
        const specialData = await fs.readFile(path.join(__dirname, 'templates', `${templateId}_special.json`), 'utf-8');
        specialOrderTemplate = JSON.parse(specialData);
      } catch (err) {
        // Fallback to standard if no special order template exists
        specialOrderTemplate = labelTemplate;
      }
    } catch (error) {
      throw new Error(`Failed to load template file: ${templateId}.json`);
    }

    // Double-check sorting by SKU alphabetically
    items.sort((a, b) => (a.sku || '').localeCompare(b.sku || '', undefined, { sensitivity: 'base' }));

    // ... (Keep your doc initialization and barcode generation the same) ...
    const doc = new PDFDocument({
      size: 'letter',
      margins: { top: 36, bottom: 36, left: 13.5, right: 13.5 },
      autoFirstPage: true
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="PO_${poId}_Labels.pdf"`);
    doc.pipe(res);

    // Calculate start position offset on a 3x10 Avery 5960 sheet
    // Row 1, Col 1 = index 0. Row 8, Col 3 = (7 * 3) + 2 = 23
    const startOffset = Math.max(0, ((startRow - 1) * 3) + (startCol - 1));
    let labelCount = startOffset;

    for (const item of items) {
         let barcodeBuffer = null;
         if (item.sku && item.sku !== 'UNKNOWN') {
           try {
             barcodeBuffer = await bwipjs.toBuffer({ bcid: 'code128', text: item.sku, scale: 3, height: 10, includetext: false });
           } catch (err) {
             console.error(`Barcode error for SKU ${item.sku}:`, err);
           }
         }

         const valuesMap = {
          name: item.name || '',
          sku: item.sku || '',
          price: item.price || '$0.00',
          customerName: item.customerName || 'NO NAME PROVIDED',
          specialTag: '*** SPECIAL ORDER ***',
          store: customText // Mapped directly to the custom UI input!
        };

         // Calculate how many of each label type to print
         const soQty = Math.min(item.qty, item.soQty || 0); // Can't have more SOs than total qty
         const normalQty = item.qty - soQty;

         // Helper function to draw a single label
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

         // Draw the Special Order labels first
         for (let i = 0; i < soQty; i++) drawLabel(specialOrderTemplate);
         
         // Draw the remaining standard labels
         for (let i = 0; i < normalQty; i++) drawLabel(labelTemplate);
       }

    doc.end();
  } catch (error) {
    console.error('PDF Generation Error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});
const PORT = process.env.PORT || 8080;
ensureTemplatesExist().then(() => {
  app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
});
