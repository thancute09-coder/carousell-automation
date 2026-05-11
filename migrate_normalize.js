/**
 * One-shot migration: dedupe furniture_matches.json and seen_listings.json
 * by stripping query-string tracking params from listing URLs.
 *
 * Carousell appends rotating ?t-id=... params to every listing URL on
 * every page visit, so previous scans saw the same listing as "new"
 * over and over. This script consolidates each listing to a single
 * canonical record (the most recently first_seen_at occurrence) and
 * rewrites both files in place. Run once, after upgrading monitor.js.
 *
 * Usage:  node migrate_normalize.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const MATCHES = path.join(ROOT, 'furniture_matches.json');
const SEEN = path.join(ROOT, 'seen_listings.json');
const LISTINGS = path.join(ROOT, 'listings.json');

function normalize(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    return u.origin + u.pathname.replace(/\/+$/, '');
  } catch {
    return url.split('?')[0].split('#')[0].replace(/\/+$/, '');
  }
}

function backup(file) {
  if (!fs.existsSync(file)) return;
  const bak = file + '.bak.' + Date.now();
  fs.copyFileSync(file, bak);
  console.log(`  Backup: ${path.basename(bak)}`);
}

// ---------- furniture_matches.json ----------
let matches = [];
if (fs.existsSync(MATCHES)) {
  matches = JSON.parse(fs.readFileSync(MATCHES, 'utf8'));
  console.log(`furniture_matches.json: ${matches.length} records`);
  backup(MATCHES);

  // Dedupe by normalized URL; keep the entry with the latest first_seen_at,
  // and prefer one that has an image_url filled in.
  const byNorm = new Map();
  for (const r of matches) {
    const key = normalize(r.listing_url);
    if (!key) continue;
    const existing = byNorm.get(key);
    if (!existing) {
      byNorm.set(key, r);
      continue;
    }
    const existingHasImg = existing.image_url && existing.image_url.length > 0;
    const newHasImg = r.image_url && r.image_url.length > 0;
    const existingTime = Date.parse(existing.first_seen_at || 0) || 0;
    const newTime = Date.parse(r.first_seen_at || 0) || 0;
    // Prefer the one with an image. Tie-break by newer first_seen_at.
    if (newHasImg && !existingHasImg) byNorm.set(key, r);
    else if (newHasImg === existingHasImg && newTime > existingTime) byNorm.set(key, r);
  }

  // Normalize the listing_url field in each survivor.
  const cleaned = Array.from(byNorm.values()).map((r) => ({
    ...r,
    listing_url: normalize(r.listing_url),
  }));
  // Sort by first_seen_at ascending so the file stays in chronological order.
  cleaned.sort((a, b) => (Date.parse(a.first_seen_at) || 0) - (Date.parse(b.first_seen_at) || 0));

  fs.writeFileSync(MATCHES, JSON.stringify(cleaned, null, 2), 'utf8');
  console.log(`  Wrote ${cleaned.length} unique records (removed ${matches.length - cleaned.length} duplicates)`);
}

// ---------- seen_listings.json ----------
if (fs.existsSync(SEEN)) {
  const seen = JSON.parse(fs.readFileSync(SEEN, 'utf8'));
  const keys = Object.keys(seen);
  console.log(`seen_listings.json: ${keys.length} keys`);
  backup(SEEN);

  const out = {};
  for (const k of keys) {
    const norm = normalize(k);
    if (!norm) continue;
    const entry = seen[k];
    const existing = out[norm];
    if (!existing) {
      out[norm] = entry;
      continue;
    }
    // Keep the older first_seen_at; preserve pushed_to_sheet if either is true.
    const existingTime = Date.parse(existing.first_seen_at || 0) || Infinity;
    const newTime = Date.parse(entry.first_seen_at || 0) || Infinity;
    out[norm] = {
      first_seen_at: newTime < existingTime ? entry.first_seen_at : existing.first_seen_at,
      source_search_url: existing.source_search_url || entry.source_search_url,
      pushed_to_sheet: !!(existing.pushed_to_sheet || entry.pushed_to_sheet),
    };
  }

  fs.writeFileSync(SEEN, JSON.stringify(out, null, 2), 'utf8');
  console.log(`  Wrote ${Object.keys(out).length} unique keys (removed ${keys.length - Object.keys(out).length} duplicates)`);
}

// ---------- listings.json (regenerate from cleaned matches) ----------
if (fs.existsSync(MATCHES)) {
  const all = JSON.parse(fs.readFileSync(MATCHES, 'utf8'));
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;

  function estimatePostedAt(record) {
    const seenAtMs = Date.parse(record.first_seen_at || '') || Date.now();
    const t = (record.posted_time || '').toLowerCase().trim();
    if (!t) return seenAtMs;
    const m = t.match(/(\d+)\s*(second|minute|hour|day|week|month|year)s?\s*ago/);
    if (m) {
      const n = parseInt(m[1], 10);
      const unit = m[2];
      const map = { second: 1000, minute: 60000, hour: 3600000, day: 86400000, week: 604800000, month: 2592000000, year: 31536000000 };
      return seenAtMs - n * map[unit];
    }
    if (t.includes('just now') || t.includes('moments ago')) return seenAtMs;
    if (t.includes('yesterday')) return seenAtMs - 86400000;
    return seenAtMs;
  }

  const enriched = all.map((r) => ({
    ...r,
    estimated_posted_at: new Date(estimatePostedAt(r)).toISOString(),
  }));
  const filtered = enriched.filter((r) => Date.parse(r.estimated_posted_at) >= cutoff);
  const sorted = filtered.sort((a, b) => Date.parse(b.estimated_posted_at) - Date.parse(a.estimated_posted_at));
  const trimmed = sorted.slice(0, 500);

  const payload = {
    generated_at: new Date().toISOString(),
    window_days: 7,
    count: trimmed.length,
    total_matches: all.length,
    listings: trimmed,
  };
  fs.writeFileSync(LISTINGS, JSON.stringify(payload, null, 2), 'utf8');
  const withImg = trimmed.filter((l) => l.image_url && l.image_url.length).length;
  console.log(`listings.json regenerated: ${trimmed.length} of ${all.length} total · ${withImg} have image_url`);
}

console.log('\nMigration complete.');
