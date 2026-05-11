/**
 * One-shot backfill: pushes every record from furniture_matches.json
 * into the configured Google Sheet. Skips rows that are already in the
 * sheet (matched by listing_url) so it's safe to re-run.
 *
 * Run with:  node backfill_to_sheets.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');

function loadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

const HEADERS = [
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

(async () => {
  const config = loadJson(CONFIG_PATH, null);
  if (!config) {
    console.error('Could not read config.json.');
    process.exit(1);
  }
  const sheetsCfg = config.googleSheets || {};
  if (!sheetsCfg.spreadsheetId) {
    console.error('config.json googleSheets.spreadsheetId is required.');
    process.exit(1);
  }
  const sheetName = sheetsCfg.sheetName || 'Sheet1';
  const keyFile = path.isAbsolute(sheetsCfg.serviceAccountPath || '')
    ? sheetsCfg.serviceAccountPath
    : path.join(ROOT, sheetsCfg.serviceAccountPath || 'google-service-account.json');

  if (!fs.existsSync(keyFile)) {
    console.error(`Service account file not found: ${keyFile}`);
    process.exit(1);
  }

  const matchesPath = path.join(ROOT, config.outputJson || 'furniture_matches.json');
  if (!fs.existsSync(matchesPath)) {
    console.error(`Matches file not found: ${matchesPath}`);
    process.exit(1);
  }

  const records = loadJson(matchesPath, []);
  if (!Array.isArray(records) || records.length === 0) {
    console.log('No records to backfill.');
    return;
  }

  console.log(`Loaded ${records.length} record(s) from ${path.basename(matchesPath)}.`);

  // Auth
  const auth = new google.auth.GoogleAuth({
    keyFile,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });

  // Verify sheet is reachable.
  let meta;
  try {
    meta = await sheets.spreadsheets.get({ spreadsheetId: sheetsCfg.spreadsheetId });
    console.log(`Connected to sheet: "${meta.data.properties.title}"`);
  } catch (err) {
    console.error('Failed to open sheet:', err.message);
    if (err.code === 403) {
      console.error('Hint: share the sheet with the service account email as Editor,');
      console.error('and ensure the Google Sheets API is enabled in your GCP project.');
    }
    process.exit(1);
  }

  // Read existing rows so we don't double-write.
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetsCfg.spreadsheetId,
    range: `${sheetName}!A1:Z`,
  });
  const existingRows = existing.data.values || [];
  const hasHeader =
    existingRows.length > 0 && existingRows[0][0] === HEADERS[0];
  const urlColIdx = HEADERS.indexOf('listing_url');
  const seenUrls = new Set();
  if (hasHeader) {
    for (let i = 1; i < existingRows.length; i++) {
      const u = existingRows[i][urlColIdx];
      if (u) seenUrls.add(u);
    }
  }

  // Write header if missing.
  if (!hasHeader) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetsCfg.spreadsheetId,
      range: `${sheetName}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [HEADERS] },
    });
    console.log('Wrote header row.');
  }

  // Filter out records already in the sheet.
  const toAppend = records.filter((r) => r.listing_url && !seenUrls.has(r.listing_url));
  if (toAppend.length === 0) {
    console.log('All records already present in sheet. Nothing to backfill.');
    return;
  }
  console.log(`Appending ${toAppend.length} new row(s) (skipped ${records.length - toAppend.length} already in sheet)...`);

  // Convert to row arrays.
  const values = toAppend.map((r) =>
    HEADERS.map((h) => {
      const v = r[h];
      if (v === null || v === undefined) return '';
      if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
      return String(v);
    })
  );

  // Append in chunks of 500 to stay well under per-request limits.
  const CHUNK = 500;
  for (let i = 0; i < values.length; i += CHUNK) {
    const chunk = values.slice(i, i + CHUNK);
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetsCfg.spreadsheetId,
      range: `${sheetName}!A1`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: chunk },
    });
    console.log(`  Appended rows ${i + 1}-${i + chunk.length}.`);
  }

  console.log('Backfill complete.');
})().catch((err) => {
  console.error('Backfill failed:', err.message);
  process.exit(1);
});
