# Carousell Furniture Monitor

A Node.js + Playwright script that polls multiple targeted Carousell search URLs (page 1, newest-first) and surfaces only new furniture listings. Optimized for **freshness** rather than coverage.

## Why multiple targeted URLs?

A broad Carousell search (`/search/furniture`) takes time to surface brand-new listings. Targeted, narrow queries (e.g. `dining%20table`, `accent%20chair`) sorted by `time_created,descending` show new items much sooner. The script scans only **page 1** of each URL because that's where freshly-posted listings appear.

## What it does

- Loops every 5 minutes (configurable).
- Scans page 1 of each configured search URL with newest-first sorting.
- Extracts `title`, `price`, `location`, `seller_name`, `posted_time`, `listing_url`.
- Adds `source_search_url` and `first_seen_at` per match.
- Filters by furniture keywords (case-insensitive).
- Tracks already-seen listings in `seen_listings.json` so each match is reported only once.
- Marks listings posted within the last hour with `* <1h` in the console.
- Appends new matches to `furniture_matches.csv` and `furniture_matches.json`.
- Prints a clean console table of new matches every scan.
- Catches errors per URL and continues to the next one.
- Adds realistic random delays between requests.

## What it does *not* do

This script will **not** bypass login walls, CAPTCHA, rate limiting, or private/seller-only pages. It only reads what an unauthenticated visitor would see. If Carousell shows a verification screen, that URL is skipped for the cycle.

## Setup

```bash
npm install
npx playwright install
```

## Run

Two modes:

**Continuous (every 5 minutes until you stop it):**

```bash
node monitor.js
```

**Once-a-day (single scan, then exit):**

```bash
node monitor.js --once
```

Use `--once` when you want to run manually each day, or schedule it via cron / macOS launchd. Press `Ctrl+C` to stop the continuous mode.

## Daily workflow with GitHub Pages

If you want a static webpage that always shows the latest listings:

```bash
cd ~/Documents/Carousell\ Automation
node monitor.js --once           # scan once
git add listings.json
git commit -m "Update listings"
git push
```

GitHub Pages updates `https://<you>.github.io/<repo>/` automatically within a minute. `index.html` is included — open it locally in any browser, or serve it via GitHub Pages.

## Configuration

Edit `config.json`:

| Field | Description |
|---|---|
| `searchUrls` | Array of Carousell search URLs (use `?sort_by=time_created%2Cdescending` for newest-first). |
| `keywords` | Furniture keywords; matched case-insensitively against title + seller name. |
| `scanIntervalMinutes` | Minutes between scans (default 5). |
| `outputCsv` | CSV output filename. |
| `outputJson` | JSON output filename (append-only, full history). |
| `webJson` | Web-friendly JSON for the HTML viewer (default `listings.json`). |
| `webJsonMax` | Max records in the web JSON (default 500). |
| `webJsonMaxAgeDays` | Only include listings posted within N days (default 7; null to disable). |

## Output files

- `furniture_matches.csv` — appends one row per new match, with header on first write.
- `furniture_matches.json` — JSON array of all new matches across runs.
- `seen_listings.json` — dedupe state. Delete this file to re-surface every listing on the next run.

## Google Sheets auto-push

Each scan can append new matches directly to a Google Sheet.

Setup:

1. In Google Cloud Console, enable the **Google Sheets API** for your project.
2. Create a **service account** and download its **JSON key**. Save the file in this folder as `google-service-account.json` (or set a different filename in `config.json` → `googleSheets.serviceAccountPath`).
3. Open the Google Sheet you want to write to → **Share** → paste the service account's `client_email` → set role to **Editor**.
4. In `config.json`, set `googleSheets.spreadsheetId` to the long ID in the sheet URL (`/spreadsheets/d/<ID>/edit`) and `googleSheets.sheetName` to the tab name (default `Sheet1`).
5. Set `googleSheets.enabled` to `true`.

The script writes a header row on first push if the sheet is empty, then appends one row per new match. Push failures are logged but don't stop the scan loop. Set `enabled` to `false` to disable Sheets push entirely.

> The `google-service-account.json` file is sensitive. Don't commit it to git — add it to `.gitignore`.

## Tips

- Add or remove search URLs in `config.json` to tune freshness vs. coverage.
- If you want to surface listings only from a specific city, append `&location_id=...` to the search URLs (use the value Carousell sets when you filter by location in the browser).
- The relative-time parser handles common Carousell formats ("5 minutes ago", "1 hour ago", "Yesterday"). Anything older falls through and is simply not flagged as fresh.
