/**
 * Witch-worker — a minimal content API for static Hugo sites.
 *
 * Pairs with the Witch Obsidian CMS plugin (publisher) and the site build
 * (scripts/sync-content.js in this repo, or your own). Store published
 * content in R2, trigger Cloudflare Pages builds, and keep your static site
 * fully static: this Worker is only involved at publish/build time and via a
 * cron that triggers scheduled rebuilds.
 */

export interface Env {
  /** R2 bucket. Content is stored under the `content/` prefix. */
  SITE_CONTENT: R2Bucket;
  /** Bearer token shared between the CMS plugin and the build step. */
  CONTENT_API_TOKEN: string;
  /** Cloudflare Pages build hook URL used by POST /api/build and cron. */
  BUILD_HOOK_URL: string;
}

const CONTENT_PREFIX = 'content/';
const BUILD_META_KEY = 'meta/build.json';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (!(await isAuthorized(request, env))) {
      return new Response('Unauthorized', { status: 401 });
    }

    if (path === '/api/manifest' && request.method === 'GET') {
      return getManifest(env);
    }

    const contentMatch = path.match(/^\/api\/content\/(.+)$/);
    if (contentMatch) {
      const key = CONTENT_PREFIX + safeDecode(contentMatch[1]);
      switch (request.method) {
        case 'GET':
          return getContent(env, key);
        case 'PUT':
          return putContent(env, request, key);
        case 'DELETE':
          return deleteContent(env, key);
        default:
          return new Response('Method not allowed', { status: 405 });
      }
    }

    if (path === '/api/images' && request.method === 'GET') {
      return getImages(env);
    }

    const imageMatch = path.match(/^\/api\/images\/(.+)$/);
    if (imageMatch && request.method === 'DELETE') {
      return deleteImage(env, safeDecode(imageMatch[1]));
    }

    if (path === '/api/build' && request.method === 'POST') {
      return triggerBuild(env);
    }

    if (path === '/api/status' && request.method === 'GET') {
      return getBuildStatus(env);
    }

    return new Response('Not found', { status: 404 });
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Rebuild so scheduled posts (published_at in the future) go live once their
    // date passes. Only rebuild when there is actually something due: a pending
    // schedule, or content published since the last build.
    if (await shouldRebuild(env)) {
      ctx.waitUntil(triggerBuild(env));
    }
  },
};

export interface BuildMeta {
  lastBuildAt?: string;
  lastBuildStatus?: string;
  detail?: string;
  /** Earliest future published_at seen during the last scan, or null. */
  nextDueAt?: string | null;
}

export async function shouldRebuild(env: Env): Promise<boolean> {
  let meta: BuildMeta = {};
  const stored = await env.SITE_CONTENT.get(BUILD_META_KEY);
  if (stored) {
    try {
      meta = JSON.parse(await stored.text()) as BuildMeta;
    } catch {
      // ignore unreadable build meta and fall through to a full scan
    }
  }

  const now = Date.now();
  const lastBuildAt = meta.lastBuildAt ? new Date(meta.lastBuildAt).getTime() : 0;

  // List content keys (no reads yet) so idle ticks stay cheap.
  const keys: Array<{ key: string; uploaded: number }> = [];
  let cursor: string | undefined;
  do {
    const listed = await env.SITE_CONTENT.list({ prefix: CONTENT_PREFIX, cursor });
    for (const obj of listed.objects) {
      keys.push({ key: obj.key, uploaded: obj.uploaded?.getTime() ?? 0 });
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  // >= (not >): an upload landing in the same millisecond as a build must
  // still trigger a scan — a redundant scan is harmless, a miss is not.
  const uploadedSinceBuild = Number.isNaN(lastBuildAt) || keys.some(entry => entry.key.endsWith('.md') && entry.uploaded >= lastBuildAt);
  // A completed scan (nextDueAt present, even when null) plus no uploads
  // since the last build means nothing could have changed: skip the reads.
  // Undefined nextDueAt means no scan ever ran (legacy meta) — scan once.
  const scanned = meta.nextDueAt !== undefined;
  const nextDue = meta.nextDueAt ? new Date(meta.nextDueAt).getTime() : NaN;
  if (scanned && !uploadedSinceBuild && (meta.nextDueAt === null || (!Number.isNaN(nextDue) && now < nextDue))) {
    return false;
  }

  let nextDueAt: string | null = null;
  let dueSinceLastBuild = false;

  for (const { key } of keys) {
    if (!key.endsWith('.md')) {
      continue;
    }
    const obj = await env.SITE_CONTENT.get(key);
    if (!obj) {
      continue;
    }
    const text = await obj.text();
    const match = text.match(/published_at:\s*["']?([^"'\n]+)/);
    if (!match) {
      continue;
    }
    const time = new Date(match[1]).getTime();
    if (Number.isNaN(time)) {
      continue;
    }
    if (time > now) {
      if (nextDueAt === null || time < new Date(nextDueAt).getTime()) {
        nextDueAt = new Date(time).toISOString();
      }
    } else if (time > lastBuildAt) {
      dueSinceLastBuild = true;
    }
    if (dueSinceLastBuild && nextDueAt !== null) {
      break;
    }
  }

  await recordScanMeta(env, meta, nextDueAt);
  return dueSinceLastBuild || uploadedSinceBuild;
}

async function isAuthorized(request: Request, env: Env): Promise<boolean> {
  const provided = request.headers.get('Authorization') || '';
  const expected = `Bearer ${env.CONTENT_API_TOKEN}`;
  if (!env.CONTENT_API_TOKEN || provided.length !== expected.length) {
    return false;
  }
  const a = new TextEncoder().encode(provided);
  const b = new TextEncoder().encode(expected);
  return crypto.subtle.timingSafeEqual(a, b);
}

async function getManifest(env: Env): Promise<Response> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const listed = await env.SITE_CONTENT.list({ prefix: CONTENT_PREFIX, cursor });
    for (const obj of listed.objects) {
      keys.push(obj.key.slice(CONTENT_PREFIX.length));
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return json({ keys });
}

async function getContent(env: Env, key: string): Promise<Response> {
  const obj = await env.SITE_CONTENT.get(key);
  if (!obj) {
    return new Response('Not found', { status: 404 });
  }
  return new Response(obj.body, {
    headers: { 'content-type': obj.httpMetadata?.contentType || 'application/octet-stream' },
  });
}

async function putContent(env: Env, request: Request, key: string): Promise<Response> {
  const body = await request.arrayBuffer();
  await env.SITE_CONTENT.put(key, body, {
    httpMetadata: { contentType: contentTypeFor(key) },
  });
  return json({ ok: true, key });
}

async function deleteContent(env: Env, key: string): Promise<Response> {
  await env.SITE_CONTENT.delete(key);
  return json({ ok: true });
}

async function getImages(env: Env): Promise<Response> {
  const images: Array<{ key: string; size: number; uploaded: string }> = [];
  let cursor: string | undefined;
  do {
    const listed = await env.SITE_CONTENT.list({ cursor });
    for (const obj of listed.objects) {
      // Show everything except the content store and build metadata, so the
      // media library surfaces images/, media/ (video/audio), and og/ cards.
      if (obj.key.startsWith(CONTENT_PREFIX) || obj.key.startsWith('meta/')) {
        continue;
      }
      images.push({
        key: obj.key,
        size: obj.size,
        uploaded: obj.uploaded.toISOString(),
      });
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return json({ images });
}

async function deleteImage(env: Env, key: string): Promise<Response> {
  await env.SITE_CONTENT.delete(key);
  return json({ ok: true });
}

async function triggerBuild(env: Env): Promise<Response> {
  if (!env.BUILD_HOOK_URL) {
    await recordBuildMeta(env, 'error', 'BUILD_HOOK_URL not configured');
    return json({ ok: false, error: 'BUILD_HOOK_URL not configured' }, 500);
  }
  const res = await fetch(env.BUILD_HOOK_URL, { method: 'POST' });
  if (!res.ok) {
    await recordBuildMeta(env, 'error', `hook HTTP ${res.status}`);
    return json({ ok: false, status: res.status }, 502);
  }
  await recordBuildMeta(env, 'ok');
  return json({ ok: true });
}

async function recordScanMeta(env: Env, meta: BuildMeta, nextDueAt: string | null): Promise<void> {
  const merged: BuildMeta = { ...meta, nextDueAt };
  await env.SITE_CONTENT.put(BUILD_META_KEY, JSON.stringify(merged), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
  });
}

async function recordBuildMeta(env: Env, status: 'ok' | 'error', detail?: string): Promise<void> {
  // Preserve the scheduler's nextDueAt across builds.
  let nextDueAt: string | null | undefined;
  const stored = await env.SITE_CONTENT.get(BUILD_META_KEY);
  if (stored) {
    try {
      nextDueAt = (JSON.parse(await stored.text()) as BuildMeta).nextDueAt;
    } catch {
      // ignore unreadable build meta
    }
  }
  const meta: BuildMeta = { lastBuildAt: new Date().toISOString(), lastBuildStatus: status, detail: detail ?? '' };
  if (nextDueAt !== undefined) {
    meta.nextDueAt = nextDueAt;
  }
  await env.SITE_CONTENT.put(BUILD_META_KEY, JSON.stringify(meta), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
  });
}

async function getBuildStatus(env: Env): Promise<Response> {
  const obj = await env.SITE_CONTENT.get(BUILD_META_KEY);
  if (!obj) {
    return json({ lastBuildAt: null, lastBuildStatus: null });
  }
  const text = await obj.text();
  try {
    const parsed = JSON.parse(text) as { lastBuildAt?: string; lastBuildStatus?: string; detail?: string };
    return json({
      lastBuildAt: parsed.lastBuildAt ?? null,
      lastBuildStatus: parsed.lastBuildStatus ?? null,
      detail: parsed.detail ?? '',
    });
  } catch {
    return json({ lastBuildAt: null, lastBuildStatus: null });
  }
}

function contentTypeFor(key: string): string {
  if (key.endsWith('.md')) return 'text/markdown; charset=utf-8';
  if (key.endsWith('.json')) return 'application/json; charset=utf-8';
  if (key.endsWith('.yaml') || key.endsWith('.yml')) return 'text/yaml; charset=utf-8';
  if (key.endsWith('.html')) return 'text/html; charset=utf-8';
  return 'application/octet-stream';
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
