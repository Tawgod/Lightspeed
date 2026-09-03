import express from 'express';
import cors from 'cors';
import PDFDocument from 'pdfkit';
import bwipjs from 'bwip-js';

const app = express();
app.use(express.static('public'));

const LIGHTSPEED_DOMAIN = process.env.LIGHTSPEED_DOMAIN;
const LIGHTSPEED_TOKEN = process.env.LIGHTSPEED_TOKEN;

// Avery 5960 label layout configuration (measurements in PDF points: 72 points = 1 inch)
const labelTemplate = {
  elements: [
    { type: 'text', field: 'name', x: 5, y: 5, fontSize: 8, maxWidth: 179, align: 'left' },
    { type: 'barcode', field: 'sku', x: 25, y: 20, width: 140, height: 28 },
    { type: 'text', field: 'price', x: 130, y: 55, fontSize: 12, bold: true },
    { type: 'text', field: 'sku', x: 25, y: 55, fontSize: 7, bold: false }
  ]
};

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
app.get('/api/labels/po/:poId', generatePoPdf);
app.get('/api/labels/po/:poId/pdf', generatePoPdf);

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
