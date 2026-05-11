/**
 * One-shot enricher: for every record in furniture_matches.json that's
 * missing image_url, visit the individual listing page and grab the
 * `og:image` meta tag. Saves the master file periodically so progress
 * survives interruption. Idempotent — safe to re-run.
 *
 * Usage:  node enrich_images.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = __dirname;
const MATCHES = path.join(ROOT, 'furniture_matches.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randomDelay = (min, max) => sleep(Math.floor(Math.random() * (max - min + 1)) + min);

function loadJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function saveJson(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
}

(async () => {
  const records = loadJson(MATCHES, []);
  if (!Array.isArray(records) || records.length === 0) {
    console.error('No records in furniture_matches.json.');
    process.exit(1);
  }

  const todo = records.filter((r) => r.listing_url && !(r.image_url && r.image_url.length > 0));
  console.log(`Records: ${records.length} total, ${records.length - todo.length} already enriched, ${todo.length} to fetch.`);
  if (todo.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    viewport: { width: 1366, height: 900 },
    locale: 'en-PH',
  });
  const page = await context.newPage();

  // Block heavy resources to speed up; we only need the HTML <head>.
  await page.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (['image', 'media', 'font', 'stylesheet'].includes(type)) return route.abort();
    return route.continue();
  });

  let updated = 0;
  let failed = 0;
  let saveCounter = 0;

  for (let i = 0; i < todo.length; i++) {
    const r = todo[i];
    try {
      await page.goto(r.listing_url, { waitUntil: 'domcontentloaded', timeout: 25000 });
      // og:image is in <head>, populated server-side for social previews.
      const ogImage = await page.evaluate(() => {
        const sel = (q) => document.querySelector(q);
        const tags = [
          'meta[property="og:image"]',
          'meta[name="og:image"]',
          'meta[name="twitter:image"]',
          'link[rel="image_src"]',
        ];
        for (const t of tags) {
          const el = sel(t);
          if (el) {
            const v = el.getAttribute('content') || el.getAttribute('href');
            if (v) return v;
          }
        }
        return '';
      });

      if (ogImage) {
        r.image_url = ogImage;
        updated++;
      } else {
        failed++;
      }
    } catch (err) {
      failed++;
      // Log first few errors to surface broken patterns; stay quiet after.
      if (failed <= 5) {
        console.error(`  [${i + 1}/${todo.length}] ${r.listing_url} → ${err.message.slice(0, 80)}`);
      }
    }

    saveCounter++;
    if (saveCounter >= 25 || i === todo.length - 1) {
      saveJson(MATCHES, records);
      saveCounter = 0;
      console.log(`  Progress: ${i + 1}/${todo.length} · enriched ${updated} · failed ${failed}`);
    }

    // Polite random delay between listing fetches.
    await randomDelay(800, 1800);
  }

  await browser.close();

  console.log(`\nDone. Enriched ${updated} record(s), ${failed} failed (likely sold/removed/blocked).`);
  console.log('Run `node monitor.js --once` to regenerate listings.json with the new images.');
})().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
