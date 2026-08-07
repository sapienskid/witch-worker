#!/usr/bin/env node
// sync-content.js — pull published content from a witch-worker instance and
// render it as Hugo content. Drop this into any Hugo repo and wire it into
// your build:
//
//   "build": "node scripts/sync-content.js && hugo --minify"
//
// Usage:
//   node scripts/sync-content.js
//   node scripts/sync-content.js --url http://localhost:8787 --token dev-token
//   node scripts/sync-content.js --content-dir content --config data/config.yaml
//   node scripts/sync-content.js --watch
//
// Env: CONTENT_API_URL, CONTENT_API_TOKEN

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import yaml from 'js-yaml';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = {
    url: process.env.CONTENT_API_URL,
    token: process.env.CONTENT_API_TOKEN,
    contentDir: process.env.CONTENT_DIR || 'content',
    config: process.env.CONTENT_CONFIG_PATH || '',
    watch: false,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--url') args.url = argv[i + 1];
    if (argv[i] === '--token') args.token = argv[i + 1];
    if (argv[i] === '--content-dir') args.contentDir = argv[i + 1];
    if (argv[i] === '--config') args.config = argv[i + 1];
    if (argv[i] === '--watch') args.watch = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.url || !args.token) {
    console.warn('⚠️  CONTENT_API_URL/CONTENT_API_TOKEN not set. Skipping content sync.');
    return;
  }

  const base = args.url.replace(/\/$/, '');
  const headers = { Authorization: `Bearer ${args.token}` };
  const contentDir = path.resolve(__dirname, '..', args.contentDir);
  const configPath = args.config ? path.resolve(__dirname, '..', args.config) : null;

  const syncOnce = async () => {
    try {
      console.log('🔄 Syncing content from', base);
      const manifestRes = await fetch(`${base}/api/manifest`, { headers });
      if (!manifestRes.ok) throw new Error(`manifest HTTP ${manifestRes.status}`);
      const { keys } = await manifestRes.json();

      const mdKeys = [];
      let siteJson = null;

      for (const key of keys) {
        if (key === 'site.json') {
          siteJson = await fetchKey(base, headers, key);
          continue;
        }
        if (/\.(md|markdown)$/.test(key)) mdKeys.push(key);
      }

      let written = 0;
      for (const key of mdKeys) {
        const raw = await fetchKey(base, headers, key);
        if (raw == null) continue;
        const content = applyDraftLogic(raw);
        const dest = path.join(contentDir, key);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, content, 'utf8');
        written++;
      }

      let removed = 0;
      if (fs.existsSync(contentDir)) {
        removed = reconcile(contentDir, new Set(mdKeys));
      }

      if (siteJson != null && configPath) {
        mergeSiteConfig(JSON.parse(siteJson), configPath);
      }

      console.log(`✅ Synced. Wrote: ${written}, Removed: ${removed}, Keys: ${keys.length}`);
    } catch (err) {
      console.error('❌ Content sync failed:', err.message);
      if (!args.watch) process.exitCode = 1;
    }
  };

  if (args.watch) {
    await syncOnce();
    setInterval(syncOnce, 3000);
  } else {
    await syncOnce();
  }
}

async function fetchKey(base, headers, key) {
  const res = await fetch(`${base}/api/content/${encodeURIComponent(key)}`, { headers });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`content ${key} HTTP ${res.status}`);
  return res.text();
}

// Scheduled posts (published_at in the future) are hidden (draft: true) until
// their date passes, at which point a cron-triggered rebuild publishes them.
function applyDraftLogic(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return raw;

  const frontmatter = m[1];
  const publishedAt = frontmatter.match(/published_at:\s*["']?([^"'\n]+)/);
  const due = publishedAt ? new Date(publishedAt[1]).getTime() <= Date.now() : true;
  const draft = due ? 'false' : 'true';

  let body = raw;
  if (/^draft:\s*\w+/m.test(frontmatter)) {
    body = raw.replace(/^draft:\s*\w+/m, `draft: ${draft}`);
  } else {
    body = raw.replace(/^---\n/, `---\ndraft: ${draft}\n`);
  }
  return body;
}

function reconcile(dir, manifestKeys) {
  let removed = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = path.relative(dir, path.join(dir, entry.name));
    if (entry.isDirectory()) {
      removed += reconcile(path.join(dir, entry.name), manifestKeys);
      if (fs.existsSync(path.join(dir, entry.name)) && fs.readdirSync(path.join(dir, entry.name)).length === 0) {
        fs.rmdirSync(path.join(dir, entry.name));
      }
    } else if (entry.isFile()) {
      if (!manifestKeys.has(rel)) {
        fs.unlinkSync(path.join(dir, entry.name));
        removed++;
      }
    }
  }
  return removed;
}

function deepMerge(base, override) {
  const out = { ...base };
  for (const [k, v] of Object.entries(override || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function mergeSiteConfig(siteJson, configPath) {
  const existing = fs.existsSync(configPath) ? yaml.load(fs.readFileSync(configPath, 'utf8')) || {} : {};
  const merged = deepMerge(existing, siteJson);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, yaml.dump(merged, { lineWidth: -1 }), 'utf8');
  console.log('🪄  Merged site.json into', configPath);
}

main();
