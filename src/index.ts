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

    if (path === '/api/build' && request.method === 'POST') {
      return triggerBuild(env);
    }

    return new Response('Not found', { status: 404 });
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Periodic rebuild so scheduled posts (published_at in the future)
    // go live automatically once their date passes.
    if (env.BUILD_HOOK_URL) {
      ctx.waitUntil(triggerBuild(env));
    }
  },
};

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

async function triggerBuild(env: Env): Promise<Response> {
  if (!env.BUILD_HOOK_URL) {
    return json({ ok: false, error: 'BUILD_HOOK_URL not configured' }, 500);
  }
  const res = await fetch(env.BUILD_HOOK_URL, { method: 'POST' });
  if (!res.ok) {
    return json({ ok: false, status: res.status }, 502);
  }
  return json({ ok: true });
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
