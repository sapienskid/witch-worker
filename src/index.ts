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
const IMAGES_PREFIX = 'images/';
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
      return deleteImage(env, IMAGES_PREFIX + safeDecode(imageMatch[1]));
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

async function shouldRebuild(env: Env): Promise<boolean> {
  let lastBuildAt = 0;
  const meta = await env.SITE_CONTENT.get(BUILD_META_KEY);
  if (meta) {
    try {
      const parsed = JSON.parse(await meta.text()) as { lastBuildAt?: string };
      const time = parsed.lastBuildAt ? new Date(parsed.lastBuildAt).getTime() : 0;
      if (!Number.isNaN(time)) {
        lastBuildAt = time;
      }
    } catch {
      // ignore unreadable build meta
    }
  }

  const now = Date.now();
  let pending = false;
  let dueSinceLastBuild = false;

  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const listed = await env.SITE_CONTENT.list({ prefix: CONTENT_PREFIX, cursor });
    for (const obj of listed.objects) {
      keys.push(obj.key);
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  for (const key of keys) {
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
      pending = true;
    } else if (time > lastBuildAt) {
      dueSinceLastBuild = true;
    }
    if (pending && dueSinceLastBuild) {
      break;
    }
  }

  return pending || dueSinceLastBuild;
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
    const listed = await env.SITE_CONTENT.list({ prefix: IMAGES_PREFIX, cursor });
    for (const obj of listed.objects) {
      images.push({
        key: obj.key.slice(IMAGES_PREFIX.length),
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

async function recordBuildMeta(env: Env, status: 'ok' | 'error', detail?: string): Promise<void> {
  const meta = { lastBuildAt: new Date().toISOString(), lastBuildStatus: status, detail: detail ?? '' };
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
