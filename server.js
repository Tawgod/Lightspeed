import express from 'express';
import cors from 'cors';
import PDFDocument from 'pdfkit';
import bwipjs from 'bwip-js';

const app = express();
app.use(cors());

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

// Health-check route (to test if Railway is live)
app.get('/', (req, res) => {
  res.send('Lightspeed Avery Label API is running.');
});

// PDF generation endpoint (supports both /api/labels/po/:poId and /api/labels/po/:poId/pdf)
async function generatePoPdf(req, res) {
  try {
    const { poId } = req.params;

    if (!LIGHTSPEED_DOMAIN || !LIGHTSPEED_TOKEN) {
      return res.status(500).send('Server configuration missing: LIGHTSPEED_DOMAIN or LIGHTSPEED_TOKEN.');
    }

    // 1. Fetch Purchase Order line items from Lightspeed
    // Clean the domain just in case https:// or trailing slashes were accidentally included
const cleanDomain = LIGHTSPEED_DOMAIN.replace(/^https?:\/\//, '').replace(/\/$/, '').replace('.retail.lightspeed.app', '');

const poResponse = await fetch(`https://${cleanDomain}.retail.lightspeed.app/api/2.0/consignments/${poId}/products`, {
  headers: { Authorization: `Bearer ${LIGHTSPEED_TOKEN}` }
});

    if (!poResponse.ok) {
      return res.status(poResponse.status).send(`Failed to fetch PO ${poId} from Lightspeed`);
    }

    const poData = await poResponse.json();
    const lineItems = poData.data || [];

    // 2. Initialize PDF Document (US Letter: 8.5" x 11")
    const doc = new PDFDocument({
      size: 'letter',
      margins: { top: 36, bottom: 36, left: 13.5, right: 13.5 }, // 0.5" top/bottom, 0.19" left/right
      autoFirstPage: true
    });

    // 3. Configure response headers to trigger download in browser
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="PO_${poId}_Avery_5960.pdf"`);
    doc.pipe(res);

    let labelCount = 0;

    // 4. Process line items
    for (const item of lineItems) {
      const qty = item.received || item.count || 1;

      // Fetch individual product details
      const cleanDomain = LIGHTSPEED_DOMAIN.replace(/^https?:\/\//, '').replace(/\/$/, '').replace('.retail.lightspeed.app', '');
      const prodResponse = await fetch(`https://${LIGHTSPEED_DOMAIN}.retail.lightspeed.app/api/2.0/products/${item.product_id}`, {
        headers: { Authorization: `Bearer ${LIGHTSPEED_TOKEN}` }
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

      // Generate barcode buffer once per product
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
        // Start a new sheet after 30 labels
        if (labelCount > 0 && labelCount % 30 === 0) {
          doc.addPage();
        }

        // Avery 5960 Grid Math
        const positionOnPage = labelCount % 30;
        const col = positionOnPage % 3;             // 3 columns across
        const row = Math.floor(positionOnPage / 3);   // 10 rows down

        // 13.5 pt left margin + (col * (189 pt width + 9 pt gap))
        const originX = 13.5 + (col * 198);
        // 36 pt top margin + (row * 72 pt height)
        const originY = 36 + (row * 72);

        // Draw each element onto the label
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
    console.error('PDF Generation Error:', error);
    if (!res.headersSent) {
      res.status(500).send('Error generating Avery labels PDF');
    }
  }
}

app.get('/api/labels/po/:poId', generatePoPdf);
app.get('/api/labels/po/:poId/pdf', generatePoPdf);

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
