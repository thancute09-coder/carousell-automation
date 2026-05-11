/**
 * Debug script: opens one Carousell search URL and dumps the structure of
 * the first 3 listing cards (text + all <img> attributes) so we can
 * figure out where the actual product image lives in the DOM.
 *
 * Run with:  node debug_images.js
 * Writes report to: debug_images_report.json
 */

'use strict';

const fs = require('fs');
const { chromium } = require('playwright');

const URL_TO_TEST =
  'https://www.carousell.ph/search/vintage%20furniture?sort_by=time_created%2Cdescending';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    viewport: { width: 1366, height: 900 },
    locale: 'en-PH',
  });
  const page = await context.newPage();

  console.log('Loading:', URL_TO_TEST);
  await page.goto(URL_TO_TEST, { waitUntil: 'domcontentloaded', timeout: 45000 });

  // Wait for at least one product link.
  try {
    await page.waitForSelector('a[href*="/p/"]', { timeout: 15000 });
  } catch {
    console.error('No /p/ links found — page may be empty or blocked.');
    await browser.close();
    process.exit(1);
  }

  // Generous scroll to trigger lazy loading.
  for (let i = 0; i < 6; i++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight));
    await page.waitForTimeout(800);
  }

  // Scroll back to top.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(800);

  const report = await page.$$eval(
    'a[href*="/p/"]',
    (anchors) => {
      const seen = new Set();
      const cards = [];
      for (const a of anchors) {
        const href = a.getAttribute('href') || '';
        if (!href.includes('/p/')) continue;
        if (seen.has(href)) continue;
        seen.add(href);

        // Same card-finding logic as monitor.js.
        let card = a.closest('[data-testid], article, li, div');
        for (let i = 0; i < 4 && card && card.innerText && card.innerText.length < 30; i++) {
          card = card.parentElement;
        }
        if (!card) continue;

        const imgs = Array.from(card.querySelectorAll('img')).map((img) => ({
          src: img.getAttribute('src') || '',
          dataSrc: img.getAttribute('data-src') || '',
          dataOriginal: img.getAttribute('data-original') || '',
          srcset: img.getAttribute('srcset') || '',
          alt: img.getAttribute('alt') || '',
          loading: img.getAttribute('loading') || '',
          width: img.naturalWidth || 0,
          height: img.naturalHeight || 0,
          currentSrc: img.currentSrc || '',
        }));

        // Also check for background-image styles inside the card.
        const bgEls = Array.from(card.querySelectorAll('*')).filter((el) => {
          const bg = getComputedStyle(el).backgroundImage;
          return bg && bg !== 'none' && bg.includes('url(');
        });
        const backgrounds = bgEls.slice(0, 5).map((el) => ({
          tag: el.tagName,
          className: (el.className && el.className.toString) ? el.className.toString().slice(0, 100) : '',
          backgroundImage: getComputedStyle(el).backgroundImage.slice(0, 300),
        }));

        cards.push({
          href,
          cardTag: card.tagName,
          cardClass: (card.className && card.className.toString) ? card.className.toString().slice(0, 200) : '',
          cardTextSnippet: (card.innerText || '').slice(0, 200),
          imgCount: imgs.length,
          imgs,
          backgrounds,
        });

        if (cards.length >= 3) break;
      }
      return cards;
    }
  );

  fs.writeFileSync('debug_images_report.json', JSON.stringify(report, null, 2), 'utf8');

  console.log('\nCaptured', report.length, 'cards.');
  console.log('Wrote debug_images_report.json — share that file back.\n');

  for (const card of report) {
    console.log('--- Card href:', card.href);
    console.log('    card tag:', card.cardTag, 'class:', card.cardClass.slice(0, 60));
    console.log('    text:', card.cardTextSnippet.slice(0, 120));
    console.log('    <img> count:', card.imgCount);
    card.imgs.forEach((img, i) => {
      console.log(`    img[${i}] src=${img.src.slice(0, 80) || '(empty)'}`);
      if (img.srcset) console.log(`            srcset=${img.srcset.slice(0, 100)}`);
      if (img.dataSrc) console.log(`            data-src=${img.dataSrc.slice(0, 80)}`);
      if (img.currentSrc && img.currentSrc !== img.src) console.log(`            currentSrc=${img.currentSrc.slice(0, 80)}`);
    });
    if (card.backgrounds.length) {
      console.log('    background-image elements found:', card.backgrounds.length);
      card.backgrounds.forEach((b, i) => console.log(`      [${i}] ${b.tag} ${b.backgroundImage.slice(0, 100)}`));
    }
    console.log('');
  }

  await browser.close();
})().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
