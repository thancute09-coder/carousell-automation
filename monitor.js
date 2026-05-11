/**
 * Carousell Furniture Monitor
 * --------------------------------
 * - Visits multiple targeted search URLs (page 1 only).
 * - Uses newest-first sorting via the URL query string.
 * - Scrapes visible listing data with Playwright.
 * - Filters by configurable furniture keywords (case-insensitive).
 * - Persists previously seen listings in seen_listings.json so only NEW
 *   matches are surfaced on each scan.
 * - Highlights listings posted within the last hour.
 * - Saves matches to CSV and JSON.
 * - Loops every N minutes.
 *
 * IMPORTANT:
 *   This script does NOT bypass login, CAPTCHA, rate limiting, or private
 *   pages. It only reads what an unauthenticated visitor would see on the
 *   public search results page. If Carousell prompts for verification, the
 *   scan for that URL is skipped and the loop continues.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

// googleapis is optional — only required when googleSheets.enabled is true.
let google;
try {
  ({ google } = require('googleapis'));
} catch {
  google = null;
}

// ------------------------------------------------------------------
// Paths
// ------------------------------------------------------------------
const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');
const SEEN_PATH = path.join(ROOT, 'seen_listings.json');

// ------------------------------------------------------------------
// File helpers
// ------------------------------------------------------------------
function loadJson(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    return fallback;
  }
}

function saveJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// CSV writer with proper escaping. Appends to existing file or creates a new one.
function appendCsv(filePath, rows, headers) {
  if (!rows.length) return;

  const escape = (val) => {
    if (val === null || val === undefined) return '';
    const s = String(val);
    if (/[",\n\r]/.test(s)) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };

  const fileExists = fs.existsSync(filePath);
  const lines = [];
  if (!fileExists) {
    lines.push(headers.join(','));
  }
  for (const row of rows) {
    lines.push(headers.map((h) => escape(row[h])).join(','));
  }
  fs.appendFileSync(filePath, lines.join('\n') + '\n', 'utf8');
}

/**
 * Estimate the absolute time a listing was actually posted on Carousell.
 * Carousell shows relative times ("2 days ago"), so we subtract that
 * offset from first_seen_at (the moment we scraped it). Falls back to
 * first_seen_at when the relative string isn't parseable.
 */
function estimatePostedAt(record) {
  const seenAtMs = Date.parse(record.first_seen_at || '') || Date.now();
  const t = (record.posted_time || '').toLowerCase().trim();
  if (!t) return seenAtMs;

  const m = t.match(/(\d+)\s*(second|minute|hour|day|week|month|year)s?\s*ago/);
  if (m) {
    const n = parseInt(m[1], 10);
    const unit = m[2];
    const map = {
      second: 1000,
      minute: 60 * 1000,
      hour: 60 * 60 * 1000,
      day: 24 * 60 * 60 * 1000,
      week: 7 * 24 * 60 * 60 * 1000,
      month: 30 * 24 * 60 * 60 * 1000,
      year: 365 * 24 * 60 * 60 * 1000,
    };
    return seenAtMs - n * map[unit];
  }
  if (t.includes('just now') || t.includes('moments ago')) return seenAtMs;
  if (t.includes('yesterday')) return seenAtMs - 24 * 60 * 60 * 1000;
  return seenAtMs;
}

/**
 * Back-fill image_url on records in furniture_matches.json when the same
 * listing_url was just re-scraped with an image. Returns the number of
 * records updated. No-op if the map is empty or the file is missing.
 */
function enrichHistoricalImages(filePath, enrichmentMap) {
  if (!enrichmentMap || enrichmentMap.size === 0) return 0;
  if (!fs.existsSync(filePath)) return 0;
  let records;
  try {
    records = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!Array.isArray(records)) return 0;
  } catch {
    return 0;
  }

  let updated = 0;
  for (const r of records) {
    if (r.image_url && r.image_url.length > 0) continue;
    const fresh = enrichmentMap.get(normalizeListingUrl(r.listing_url));
    if (fresh) {
      r.image_url = fresh;
      updated++;
    }
  }
  if (updated > 0) {
    fs.writeFileSync(filePath, JSON.stringify(records, null, 2), 'utf8');
  }
  return updated;
}

/**
 * Rewrite a web-friendly JSON file: filtered to listings posted within
 * the past `maxAgeDays`, sorted newest-first by estimated post time,
 * capped to maxRows entries. The payload wraps the listings array with
 * a `generated_at` timestamp so a static HTML page can show "last
 * updated" info without parsing data.
 */
function writeWebJson(filePath, allRecords, maxRows, maxAgeDays) {
  if (!Array.isArray(allRecords)) allRecords = [];

  const nowMs = Date.now();
  const cutoffMs =
    maxAgeDays && maxAgeDays > 0 ? nowMs - maxAgeDays * 24 * 60 * 60 * 1000 : null;

  // Attach estimated_posted_at as a derived field and filter by age.
  const enriched = allRecords.map((r) => ({
    ...r,
    estimated_posted_at: new Date(estimatePostedAt(r)).toISOString(),
  }));

  const filtered =
    cutoffMs === null
      ? enriched
      : enriched.filter((r) => Date.parse(r.estimated_posted_at) >= cutoffMs);

  const sorted = [...filtered].sort(
    (a, b) => Date.parse(b.estimated_posted_at) - Date.parse(a.estimated_posted_at)
  );

  const trimmed = maxRows && maxRows > 0 ? sorted.slice(0, maxRows) : sorted;

  const payload = {
    generated_at: new Date().toISOString(),
    window_days: maxAgeDays || null,
    count: trimmed.length,
    total_matches: allRecords.length,
    listings: trimmed,
  };
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

// Append to a JSON array file (creates if missing).
function appendJsonArray(filePath, rows) {
  if (!rows.length) return;
  let existing = [];
  if (fs.existsSync(filePath)) {
    try {
      existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!Array.isArray(existing)) existing = [];
    } catch {
      existing = [];
    }
  }
  existing.push(...rows);
  fs.writeFileSync(filePath, JSON.stringify(existing, null, 2), 'utf8');
}

// ------------------------------------------------------------------
// Google Sheets push
// ------------------------------------------------------------------
// Memoized Sheets client. Built lazily on first push.
let sheetsClientPromise = null;

async function getSheetsClient(serviceAccountPath) {
  if (sheetsClientPromise) return sheetsClientPromise;
  if (!google) {
    throw new Error(
      'googleapis is not installed. Run "npm install" to add it.'
    );
  }
  const absPath = path.isAbsolute(serviceAccountPath)
    ? serviceAccountPath
    : path.join(ROOT, serviceAccountPath);
  if (!fs.existsSync(absPath)) {
    throw new Error(`Service account JSON not found at ${absPath}`);
  }
  sheetsClientPromise = (async () => {
    const auth = new google.auth.GoogleAuth({
      keyFile: absPath,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const authClient = await auth.getClient();
    return google.sheets({ version: 'v4', auth: authClient });
  })();
  return sheetsClientPromise;
}

// Ensure the target tab has a header row. Writes one if the sheet is empty.
async function ensureSheetHeader(sheets, spreadsheetId, sheetName, headers) {
  const range = `${sheetName}!A1:Z1`;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
  });
  const existing = (res.data.values && res.data.values[0]) || [];
  if (existing.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheetName}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [headers] },
    });
  }
}

async function appendToSheet(config, rows, headers) {
  const cfg = config.googleSheets || {};
  if (!cfg.enabled) return;
  if (!rows.length) return;
  if (!cfg.spreadsheetId) {
    console.warn(`[${nowIso()}] googleSheets.spreadsheetId not set — skipping push.`);
    return;
  }

  const sheetName = cfg.sheetName || 'Sheet1';
  const sheets = await getSheetsClient(cfg.serviceAccountPath || 'google-service-account.json');

  await ensureSheetHeader(sheets, cfg.spreadsheetId, sheetName, headers);

  const values = rows.map((r) =>
    headers.map((h) => {
      const v = r[h];
      if (v === null || v === undefined) return '';
      if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
      return String(v);
    })
  );

  await sheets.spreadsheets.values.append({
    spreadsheetId: cfg.spreadsheetId,
    range: `${sheetName}!A1`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  });
}

/**
 * Retries pushing any furniture_matches.json records that are missing
 * pushed_to_sheet=true in seen_listings.json. This catches:
 *  - matches saved before Sheets was enabled
 *  - matches whose Sheets push failed in a previous run
 * Capped at 200 rows per call so we don't hammer the API.
 */
async function retryUnpushedSheetRows(config, seen) {
  const cfg = config.googleSheets || {};
  if (!cfg.enabled) return;

  const matchesPath = path.join(ROOT, config.outputJson || 'furniture_matches.json');
  if (!fs.existsSync(matchesPath)) return;

  let records;
  try {
    records = JSON.parse(fs.readFileSync(matchesPath, 'utf8'));
    if (!Array.isArray(records)) return;
  } catch {
    return;
  }

  const pending = records.filter(
    (r) => r.listing_url && !(seen[r.listing_url] && seen[r.listing_url].pushed_to_sheet)
  );
  if (pending.length === 0) return;

  const batch = pending.slice(0, 200);
  console.log(
    `[${nowIso()}] Retrying ${batch.length} unpushed row(s) ` +
      `(${pending.length} total pending)...`
  );

  const headers = [
    'first_seen_at',
    'title',
    'price',
    'location',
    'seller_name',
    'posted_time',
    'fresh_within_last_hour',
    'listing_url',
    'image_url',
    'source_search_url',
  ];

  try {
    await appendToSheet(config, batch, headers);
    for (const r of batch) {
      if (!seen[r.listing_url]) {
        seen[r.listing_url] = {
          first_seen_at: r.first_seen_at,
          source_search_url: r.source_search_url,
        };
      }
      seen[r.listing_url].pushed_to_sheet = true;
    }
    saveJson(SEEN_PATH, seen);
    console.log(`[${nowIso()}] Retry pushed ${batch.length} row(s).`);
  } catch (err) {
    console.error(`[${nowIso()}] Retry push failed: ${err.message}`);
  }
}

// ------------------------------------------------------------------
// Misc helpers
// ------------------------------------------------------------------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function randomDelay(minMs, maxMs) {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return sleep(ms);
}

function nowIso() {
  return new Date().toISOString();
}

// Convert a Carousell relative time string ("2 minutes ago", "1 hour ago",
// "Yesterday", etc.) into an approximate Date. Returns null if not parseable.
function parseRelativeTime(text) {
  if (!text) return null;
  const t = text.toLowerCase().trim();
  const now = Date.now();

  const m = t.match(/(\d+)\s*(second|minute|hour|day|week|month|year)s?\s*ago/);
  if (m) {
    const n = parseInt(m[1], 10);
    const unit = m[2];
    const map = {
      second: 1000,
      minute: 60 * 1000,
      hour: 60 * 60 * 1000,
      day: 24 * 60 * 60 * 1000,
      week: 7 * 24 * 60 * 60 * 1000,
      month: 30 * 24 * 60 * 60 * 1000,
      year: 365 * 24 * 60 * 60 * 1000,
    };
    return new Date(now - n * map[unit]);
  }
  if (t.includes('just now') || t.includes('moments ago')) {
    return new Date(now);
  }
  if (t.includes('yesterday')) {
    return new Date(now - 24 * 60 * 60 * 1000);
  }
  return null;
}

function isWithinLastHour(date) {
  if (!date) return false;
  return Date.now() - date.getTime() <= 60 * 60 * 1000;
}

function matchesKeyword(text, keywords) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return keywords.some((kw) => lower.includes(kw.toLowerCase()));
}

/**
 * Carousell appends fresh tracking params (?t-id=..., t-referrer_*, etc.)
 * to every listing URL on every page visit. To dedupe and back-fill
 * correctly across scans, we key off the URL with the query string and
 * hash stripped — leaving just the stable origin + listing path.
 */
function normalizeListingUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    return u.origin + u.pathname.replace(/\/+$/, '');
  } catch {
    return url.split('?')[0].split('#')[0].replace(/\/+$/, '');
  }
}

// ------------------------------------------------------------------
// Scraping
// ------------------------------------------------------------------
/**
 * Extracts visible listing data from a Carousell search results page.
 * The selectors below favor stability over precision — Carousell's
 * markup changes regularly. We grab anchor cards that point to /p/ URLs
 * (individual product pages) and read their text content.
 */
async function extractListings(page, sourceUrl) {
  // Wait for at least one product link to appear, but don't fail loudly.
  try {
    await page.waitForSelector('a[href*="/p/"]', { timeout: 15000 });
  } catch {
    // Either the page is empty, behind verification, or slow. Bail.
    return [];
  }

  // Scroll all the way through the page to coax every lazy-loaded image
  // into its real src. Carousell's image grid uses IntersectionObserver,
  // so each card has to be visible at least once before its <img>
  // populates. We loop scrolling to the bottom until page height stops
  // growing (handles infinite scroll), capped to keep scans bounded.
  let lastHeight = 0;
  for (let i = 0; i < 10; i++) {
    const h = await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
      return document.body.scrollHeight;
    });
    await page.waitForTimeout(700);
    if (h === lastHeight) break;
    lastHeight = h;
  }
  // Final pause to let images finish loading after the last scroll.
  await page.waitForTimeout(800);
  // Scroll back to top — not strictly required ($$eval reads all DOM),
  // but useful for parity with manual browsing.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);

  const baseOrigin = new URL(sourceUrl).origin;

  const raw = await page.$$eval(
    'a[href*="/p/"]',
    (anchors, origin) => {
      const seen = new Set();
      const results = [];

      for (const a of anchors) {
        // The "card" is the closest ancestor that contains the price and seller block.
        // Walk up a few levels and capture text.
        let card = a.closest('[data-testid], article, li, div');
        // Walk up further if the immediate ancestor is too small.
        for (let i = 0; i < 4 && card && card.innerText && card.innerText.length < 30; i++) {
          card = card.parentElement;
        }
        if (!card) continue;

        const href = a.getAttribute('href') || '';
        if (!href.includes('/p/')) continue;
        const absoluteUrl = href.startsWith('http') ? href : origin + href;
        if (seen.has(absoluteUrl)) continue;
        seen.add(absoluteUrl);

        const text = (card.innerText || '').trim();
        if (!text) continue;

        // Split into non-empty lines for heuristic parsing.
        const lines = text
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean);

        // Heuristics:
        //  - title: longest non-price, non-time line
        //  - price: line starting with currency symbol or "PHP"
        //  - seller_name: usually the first line on the card
        //  - posted_time: a line containing "ago", "yesterday", or similar
        //  - location: a line that's short and not any of the above
        let title = '';
        let price = '';
        let seller = lines[0] || '';
        let postedTime = '';
        let location = '';

        for (const line of lines) {
          const low = line.toLowerCase();
          if (!price && (/^php\b/i.test(line) || /[₱$]/.test(line))) {
            price = line;
            continue;
          }
          if (
            !postedTime &&
            (low.includes('ago') ||
              low.includes('yesterday') ||
              low.includes('just now') ||
              low.includes('moments ago'))
          ) {
            postedTime = line;
            continue;
          }
        }

        // Title: longest remaining line that is not seller/price/time.
        const remaining = lines.filter(
          (l) => l !== seller && l !== price && l !== postedTime
        );
        remaining.sort((a, b) => b.length - a.length);
        title = remaining[0] || a.innerText.trim() || '';

        // Location: a short remaining line that isn't the title.
        const shortLines = remaining.filter(
          (l) => l !== title && l.length > 0 && l.length <= 40
        );
        location = shortLines[0] || '';

        // First product image inside the card. Carousell URLs:
        //   /media/photos/profiles/... → seller avatar (skip)
        //   /media/photos/products/... → product photo (want)
        // Strategy: walk all <img> elements, take the first URL that
        // looks like a product photo. Fall back to any non-avatar src.
        let imageUrl = '';
        const imgs = card.querySelectorAll('img');
        const candidates = [];
        for (const img of imgs) {
          const raw =
            img.getAttribute('src') ||
            img.getAttribute('data-src') ||
            img.getAttribute('data-original') ||
            '';
          if (!raw) continue;
          if (raw.startsWith('data:')) continue;
          const abs = raw.startsWith('//') ? 'https:' + raw : raw;
          // Skip seller avatar URLs.
          if (/\/photos\/profiles\//.test(abs) || /\/avatar\//.test(abs)) continue;
          candidates.push(abs);
        }
        // Prefer URLs that explicitly contain /products/, else first non-avatar.
        imageUrl =
          candidates.find((c) => /\/photos\/products\//.test(c)) ||
          candidates[0] ||
          '';

        results.push({
          title,
          price,
          location,
          seller_name: seller,
          posted_time: postedTime,
          listing_url: absoluteUrl,
          image_url: imageUrl,
        });
      }
      return results;
    },
    baseOrigin
  );

  // Deduplicate by listing_url just in case.
  const dedup = new Map();
  for (const r of raw) {
    if (!dedup.has(r.listing_url)) dedup.set(r.listing_url, r);
  }
  return Array.from(dedup.values());
}

// ------------------------------------------------------------------
// Scan loop
// ------------------------------------------------------------------
async function scanOnce(browser, config, seen) {
  const scanTime = nowIso();
  console.log(`\n[${scanTime}] === Scan started ===`);

  const csvPath = path.join(ROOT, config.outputCsv);
  const jsonPath = path.join(ROOT, config.outputJson);

  const newMatches = [];
  // Map of normalized listing_url -> image_url scraped this run. Used to
  // back-fill image_url on previously-seen records that were captured
  // before image extraction worked. Keyed by normalized URL so we match
  // across scans even though Carousell rotates query string tracking
  // params on each page visit.
  const enrichmentMap = new Map();

  // Build a lookup of normalized -> original-key for the seen index so
  // we can recognize a listing as already-seen even when its current URL
  // has different tracking params than the stored one.
  const normalizedSeen = new Map();
  for (const key of Object.keys(seen)) {
    normalizedSeen.set(normalizeListingUrl(key), key);
  }

  for (const url of config.searchUrls) {
    let context;
    let page;
    try {
      console.log(`[${nowIso()}] Scanning: ${url}`);

      context = await browser.newContext({
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        viewport: { width: 1366, height: 900 },
        locale: 'en-PH',
      });
      page = await context.newPage();

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });

      // Random short wait for hydration.
      await randomDelay(1500, 3500);

      const listings = await extractListings(page, url);

      for (const l of listings) {
        if (!l.listing_url) continue;
        const normalizedUrl = normalizeListingUrl(l.listing_url);

        // Capture image_url for ALL scraped listings (new or already-seen)
        // so we can back-fill missing images on historical records. Keyed
        // by the normalized URL so it matches stored records regardless
        // of query-string tracking params.
        if (l.image_url) enrichmentMap.set(normalizedUrl, l.image_url);

        if (normalizedSeen.has(normalizedUrl)) continue; // already reported in a previous scan
        if (!matchesKeyword(`${l.title} ${l.seller_name}`, config.keywords)) continue;

        const parsedDate = parseRelativeTime(l.posted_time);
        const fresh = isWithinLastHour(parsedDate);

        const record = {
          title: l.title,
          price: l.price,
          location: l.location,
          seller_name: l.seller_name,
          posted_time: l.posted_time,
          // Store the normalized URL so future runs match cleanly. The
          // listing_url still resolves correctly when clicked.
          listing_url: normalizedUrl,
          image_url: l.image_url || '',
          source_search_url: url,
          first_seen_at: nowIso(),
          fresh_within_last_hour: fresh,
        };

        newMatches.push(record);
        seen[normalizedUrl] = {
          first_seen_at: record.first_seen_at,
          source_search_url: url,
          // pushed_to_sheet starts false; flipped true after a successful Sheets push.
          pushed_to_sheet: false,
        };
        normalizedSeen.set(normalizedUrl, normalizedUrl);
      }

      await page.close();
      await context.close();
    } catch (err) {
      console.error(`[${nowIso()}] Error scanning ${url}: ${err.message}`);
      try { if (page) await page.close(); } catch {}
      try { if (context) await context.close(); } catch {}
      // Continue to next URL.
    }

    // Polite random delay between search URLs.
    await randomDelay(2500, 6000);
  }

  // Back-fill image_url on historical records when we re-saw them this scan.
  const enriched = enrichHistoricalImages(jsonPath, enrichmentMap);
  if (enriched > 0) {
    console.log(`[${nowIso()}] Enriched ${enriched} historical record(s) with image_url.`);
  }

  if (newMatches.length === 0) {
    // Still persist seen state (in case earlier pushes set pushed_to_sheet flags).
    saveJson(SEEN_PATH, seen);
    console.log(`[${nowIso()}] No new matches this scan.`);
    // Even when there are no new matches, regenerate the web JSON so the
    // enriched image_url values flow into listings.json.
    if (config.webJson) {
      try {
        const all = loadJson(jsonPath, []);
        writeWebJson(
          path.join(ROOT, config.webJson),
          all,
          config.webJsonMax || 500,
          config.webJsonMaxAgeDays || null
        );
      } catch (err) {
        console.error(`[${nowIso()}] Failed to write web JSON: ${err.message}`);
      }
    }
    // Even with no new matches, retry any unpushed records from disk.
    await retryUnpushedSheetRows(config, seen);
    return;
  }

  // Save outputs.
  const csvHeaders = [
    'first_seen_at',
    'title',
    'price',
    'location',
    'seller_name',
    'posted_time',
    'fresh_within_last_hour',
    'listing_url',
    'image_url',
    'source_search_url',
  ];
  appendCsv(csvPath, newMatches, csvHeaders);
  appendJsonArray(jsonPath, newMatches);

  // Rewrite the web-friendly listings.json (sorted newest-first, capped).
  // Safe to do every scan — the file stays small.
  if (config.webJson) {
    try {
      const all = loadJson(jsonPath, []);
      writeWebJson(
        path.join(ROOT, config.webJson),
        all,
        config.webJsonMax || 500,
        config.webJsonMaxAgeDays || null
      );
    } catch (err) {
      console.error(`[${nowIso()}] Failed to write web JSON: ${err.message}`);
    }
  }

  // Push new matches to Google Sheets, if configured. Failures are logged
  // but don't break the scan loop. On success we mark each pushed listing
  // so we don't retry it later.
  try {
    await appendToSheet(config, newMatches, csvHeaders);
    if (config.googleSheets && config.googleSheets.enabled) {
      for (const m of newMatches) {
        if (seen[m.listing_url]) seen[m.listing_url].pushed_to_sheet = true;
      }
      console.log(`[${nowIso()}] Pushed ${newMatches.length} row(s) to Google Sheets.`);
    }
  } catch (err) {
    console.error(`[${nowIso()}] Google Sheets push failed: ${err.message}`);
  }

  // Persist seen state AFTER push so pushed_to_sheet flags are saved.
  saveJson(SEEN_PATH, seen);

  // Also retry any older records that were saved before Sheets was wired up.
  await retryUnpushedSheetRows(config, seen);

  // Console table — highlight fresh listings with a marker column.
  const tableRows = newMatches.map((m) => ({
    HOT: m.fresh_within_last_hour ? '* <1h' : '',
    title: truncate(m.title, 60),
    price: truncate(m.price, 18),
    location: truncate(m.location, 22),
    posted: truncate(m.posted_time, 18),
    url: truncate(m.listing_url, 60),
  }));

  console.log(`[${nowIso()}] ${newMatches.length} NEW match(es):`);
  console.table(tableRows);
}

function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------
(async function main() {
  const config = loadJson(CONFIG_PATH, null);
  if (!config) {
    console.error('Could not load config.json. Aborting.');
    process.exit(1);
  }
  if (!Array.isArray(config.searchUrls) || config.searchUrls.length === 0) {
    console.error('config.json must contain a non-empty "searchUrls" array.');
    process.exit(1);
  }

  const seen = loadJson(SEEN_PATH, {});

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  // CLI flag: pass --once to run a single scan and exit.
  // (Useful for "run it once a day" workflows scheduled via cron, launchd, or manually.)
  const runOnce = process.argv.includes('--once');

  const intervalMs = (config.scanIntervalMinutes || 5) * 60 * 1000;

  // Graceful shutdown.
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[${nowIso()}] Shutting down...`);
    try { await browser.close(); } catch {}
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  if (runOnce) {
    try {
      await scanOnce(browser, config, seen);
    } catch (err) {
      console.error(`[${nowIso()}] Scan error: ${err.message}`);
    }
    console.log(`[${nowIso()}] --once mode: exiting after single scan.`);
    await shutdown();
    return;
  }

  // Run forever, every intervalMs minutes.
  while (!shuttingDown) {
    try {
      await scanOnce(browser, config, seen);
    } catch (err) {
      console.error(`[${nowIso()}] Scan loop error: ${err.message}`);
    }
    console.log(
      `[${nowIso()}] Sleeping for ${config.scanIntervalMinutes || 5} minute(s)...`
    );
    await sleep(intervalMs);
  }
})();
