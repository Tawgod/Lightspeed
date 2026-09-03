import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';

const app = express();
app.use(cors());

const LIGHTSPEED_DOMAIN = process.env.LIGHTSPEED_DOMAIN;
const LIGHTSPEED_TOKEN = process.env.LIGHTSPEED_TOKEN;

// 1. Endpoint for the Chrome extension to discover available templates
app.get('/api/templates', (req, res) => {
  const templatesDir = path.join(process.cwd(), 'templates');
  const files = fs.readdirSync(templatesDir).filter(f => f.endsWith('.json'));
  
  const templates = files.map(file => {
    const data = JSON.parse(fs.readFileSync(path.join(templatesDir, file), 'utf8'));
    return { id: data.id, name: data.name };
  });

  res.json(templates);
});

// 2. Dynamic label generation endpoint
app.get('/api/labels/po/:poId', async (req, res) => {
  try {
    const { poId } = req.params;
    const templateId = req.query.template || 'avery-5960';

    // Load selected template
    const templatePath = path.join(process.cwd(), 'templates', `${templateId}.json`);
    if (!fs.existsSync(templatePath)) return res.status(400).send('Invalid template');
    const template = JSON.parse(fs.readFileSync(templatePath, 'utf8'));

    // Fetch PO products
    const poResponse = await fetch(`https://${LIGHTSPEED_DOMAIN}.retail.lightspeed.app/api/2.0/consignments/${poId}/products`, {
      headers: { 'Authorization': `Bearer ${LIGHTSPEED_TOKEN}` }
    });
    const poData = await poResponse.json();

    // Build CSV header from template columns
    const headers = template.columns.map(col => `"${col.header}"`).join(',');
    const csvRows = [headers];

    for (const item of poData.data) {
      const qty = item.received || item.count || 1;

      // Fetch full product details (to get description, tags, custom fields, etc.)
      const prodResponse = await fetch(`https://${LIGHTSPEED_DOMAIN}.retail.lightspeed.app/api/2.0/products/${item.product_id}`, {
        headers: { 'Authorization': `Bearer ${LIGHTSPEED_TOKEN}` }
      });
      const prodData = await prodResponse.json();
      const product = prodData.data;

      // Extract values dynamically
      const valuesMap = {
        name: `"${(product.name || '').replace(/"/g, '""')}"`,
        sku: `"${product.sku || ''}"`,
        price: `"$${product.price_including_tax || '0.00'}"`,
        description: `"${(product.description || '').replace(/"/g, '""')}"`,
        supplier_code: `"${product.supplier_code || ''}"`
      };

      const row = template.columns.map(col => valuesMap[col.field] || '""').join(',');

      for (let i = 0; i < qty; i++) {
        csvRows.push(row);
      }
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="PO_${poId}_${templateId}.csv"`);
    res.send(csvRows.join('\n'));

  } catch (error) {
    console.error(error);
    res.status(500).send('Error generating labels');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API running on port ${PORT}`));