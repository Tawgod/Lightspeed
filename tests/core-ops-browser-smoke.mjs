import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const css =
  readFileSync(new URL('../shared-ui/hc.css', import.meta.url), 'utf8') +
  '\n' +
  readFileSync(new URL('../shared-ui/core-ops-compat.css', import.meta.url), 'utf8');

const routes = ['special-orders', 'ordering', 'preorders', 'gw-preorders'];
const zooms = [1, 1.25, 2];

const browser = await chromium.launch({ headless: true });

try {
  for (const route of routes) {
    let html = readFileSync(new URL('../' + route + '.html', import.meta.url), 'utf8');
    html = html
      .replace(/<link[^>]+rel="stylesheet"[^>]*>/g, '')
      .replace('</head>', '<style>' + css + '</style></head>')
      .replace(/<script[\s\S]*?<\/script>/g, '');

    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.setContent(html, { waitUntil: 'domcontentloaded' });

    for (const zoom of zooms) {
      await page.evaluate((value) => {
        document.documentElement.style.zoom = String(value);
      }, zoom);

      const nav = page.locator('.hc-operations-nav');
      if (!(await nav.isVisible())) {
        throw new Error(route + ' nav hidden at zoom ' + zoom);
      }

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      );
      if (overflow > 5) {
        throw new Error(route + ' horizontal overflow ' + overflow + 'px at zoom ' + zoom);
      }

      const summary = page.locator('.hc-operations-more summary');
      await summary.focus();
      const summaryFocused = await summary.evaluate((el) => document.activeElement === el);
      if (!summaryFocused) {
        throw new Error(route + ' More menu focus failed at zoom ' + zoom);
      }
      await summary.click();
      const menuOpen = await page.locator('.hc-operations-more').evaluate((el) => el.open === true);
      if (!menuOpen) {
        throw new Error(route + ' More menu open/layout failed at zoom ' + zoom);
      }
      await page.locator('.hc-operations-more').evaluate((el) => el.removeAttribute('open'));

      const pin = page.locator('#employeePin');
      await pin.focus();
      const pinFocused = await pin.evaluate((el) => document.activeElement === el);
      if (!pinFocused) {
        throw new Error(route + ' PIN focus failed at zoom ' + zoom);
      }
    }

    await page.close();
  }
} finally {
  await browser.close();
}

console.log('core ops Chromium layout/keyboard smoke passed at 100/125/200% CSS zoom');
