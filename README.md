# witch-worker

A minimal **content API for static Hugo sites**. Published content lives in R2;
this Worker serves it to your build and triggers Cloudflare Pages rebuilds.
Pairs with the **Witch** Obsidian plugin (the CMS), but works with **any** Hugo
setup — drop in the sync script, point it at the Worker, and go.

- Static by design: the Worker is only involved at publish/build time and via a
  cron for scheduled posts. The served site never calls it at request time.

## How it fits

```
Obsidian (Witch CMS) ──PUT──▶ witch-worker (R2) ──POST /api/build──▶ Pages build hook
                                                                        ▼
Any Hugo repo: node scripts/sync-content.js && hugo --minify ──▶ static site
```

## Local dev

```bash
pnpm install                 # or npm install
cp .dev.vars.example .dev.vars   # set CONTENT_API_TOKEN
pnpm run dev                 # wrangler dev → http://localhost:8787
```

## Deploy

```bash
pnpm run deploy              # wrangler deploy
wrangler secret put CONTENT_API_TOKEN
wrangler secret put BUILD_HOOK_URL     # your Cloudflare Pages build hook
```

Create the R2 bucket first (or set `bucket_name` in `wrangler.toml` to an
existing bucket).

## API

Base: `https://witch-worker.<your-subdomain>.workers.dev`

Auth: every route requires `Authorization: Bearer <CONTENT_API_TOKEN>`
(constant-time compared).

| Method | Path | Purpose | Body |
|---|---|---|---|
| GET | `/api/manifest` | List all content keys | — |
| GET | `/api/content/:key` | Fetch a file | — |
| PUT | `/api/content/:key` | Upsert a file | raw bytes |
| DELETE | `/api/content/:key` | Delete a file | — |
| POST | `/api/build` | Trigger the Pages build hook | — |

## Key layout

Keys are the **destination path under `content/`** in the Hugo repo, so the
sync step can mirror them 1:1:

```
content/blog/<slug>.md          # posts (section = a tag like #blog/#portfolio)
content/<slug>/_index.md        # static pages (about, contact, privacy, terms)
content/tags/<slug>.md          # tag archive pages (written by the CMS)
site.json                       # site-wide settings (optionally merged into config)
tags.json                       # tag registry (reference; not consumed by the build)
```

## Using it with any Hugo site

1. Copy `scripts/sync-content.js` into your repo's `scripts/`.
2. In `package.json`:
   ```json
   "build": "node scripts/sync-content.js && hugo --minify"
   ```
3. Set env on the build host (Cloudflare Pages):
   ```
   CONTENT_API_URL=https://witch-worker.<your-subdomain>.workers.dev
   CONTENT_API_TOKEN=<token>
   ```
4. Optional: `--config data/config.yaml` makes the sync merge `site.json` into
   a config file your theme reads.

Local preview:

```bash
node scripts/sync-content.js --url http://localhost:8787 --token dev-token
hugo server -D
```

## Data model

### Published post frontmatter (Hugo-ready)

```yaml
---
title: "Post title"
date: 2026-08-07T10:00:00+05:45
lastmod: 2026-08-07T10:00:00+05:45
draft: false
slug: "my-post"
section: "blog"
tags: [ai, math]
tag_names: ["AI", "Math"]
excerpt: "Short summary."
feature_image: "https://<r2-domain>/images/my-post-1.webp"
reading_time: 4
author: "Your Name"
meta_title: "SEO title"
meta_description: "SEO description"
og_title: "..."
og_description: "..."
og_image: "https://..."
twitter_title: "..."
twitter_description: "..."
twitter_image: "https://..."
keywords: [ai, math]
published_at: "2026-08-07T10:00:00+05:45"
---
```

`draft` is derived at build time: if `published_at` is in the future the sync
writes `draft: true` (hidden) so a later cron-triggered rebuild publishes it.

### site.json

Site-wide settings merged into your config (identity, social, homepage text,
SEO defaults, nav). Shape is up to your theme — see
[`numrecall`](https://github.com/sapienskid/numrecall) for a reference.

### tags.json

Registry managed by the CMS: `{ "<slug>": { name, slug, description, color,
feature_image, parent, visibility, meta_title, meta_description } }`.

## Repository layout

```
src/index.ts            # the Worker
scripts/sync-content.js # reusable Hugo build step
wrangler.toml           # R2 binding + cron trigger
```

## Related

- **Witch** (Obsidian CMS plugin): writes content to this Worker.
- **numrecall** (reference Hugo site): theme + deployment using this Worker.
