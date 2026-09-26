import test from "node:test";
import assert from "node:assert/strict";

import worker, { shouldRebuild } from "../src/index.ts";
import type { Env } from "../src/index.ts";

// crypto.subtle.timingSafeEqual exists on Cloudflare Workers but not in
// Node — shim it for tests with an equivalent constant-time comparison.
const subtle = crypto.subtle as SubtleCrypto & {
  timingSafeEqual?: (a: ArrayBufferView, b: ArrayBufferView) => boolean;
};
if (!subtle.timingSafeEqual) {
  const { timingSafeEqual } = await import("node:crypto");
  subtle.timingSafeEqual = (a, b) =>
    a.byteLength === b.byteLength &&
    timingSafeEqual(Buffer.from(a.buffer, a.byteOffset, a.byteLength), Buffer.from(b.buffer, b.byteOffset, b.byteLength));
}

interface StoredObject {
  body: string;
  uploaded: Date;
}

class FakeR2 {
  store = new Map<string, StoredObject>();
  gets = 0;

  async get(key: string) {
    const obj = this.store.get(key);
    if (!obj) return null;
    this.gets += 1;
    return { text: async () => obj.body, body: obj.body };
  }

  async put(key: string, body: unknown, uploaded = new Date()) {
    const text =
      typeof body === "string"
        ? body
        : body instanceof ArrayBuffer
          ? new TextDecoder().decode(body)
          : ArrayBuffer.isView(body)
            ? new TextDecoder().decode(body as ArrayBufferView)
            : JSON.stringify(body);
    this.store.set(key, { body: text, uploaded });
  }

  async delete(key: string) {
    this.store.delete(key);
  }

  async list(opts?: { prefix?: string; cursor?: string }) {
    const objects = [...this.store.entries()]
      .filter(([key]) => !opts?.prefix || key.startsWith(opts.prefix))
      .map(([key, obj]) => ({ key, uploaded: obj.uploaded, size: obj.body.length }));
    return { objects, truncated: false, cursor: undefined };
  }
}

function makeEnv(fetchImpl?: (url: string) => Promise<{ ok: boolean; status: number }>) {
  const bucket = new FakeR2();
  const calls: string[] = [];
  const realFetch = (globalThis as Record<string, unknown>).fetch;
  (globalThis as Record<string, unknown>).fetch = async (url: string) => {
    calls.push(String(url));
    if (fetchImpl) return fetchImpl(String(url));
    return { ok: true, status: 200 };
  };
  const env = {
    SITE_CONTENT: bucket,
    CONTENT_API_TOKEN: "secret",
    BUILD_HOOK_URL: "https://hooks.example.com/build",
  } as unknown as Env;
  return {
    env,
    bucket,
    calls,
    restore() {
      (globalThis as Record<string, unknown>).fetch = realFetch;
    },
  };
}

function req(path: string, method = "GET", body?: string) {
  return new Request(`https://worker.test${path}`, {
    method,
    headers: { Authorization: "Bearer secret" },
    body: body ?? undefined,
  });
}

test("rejects requests without a valid token", async () => {
  const { env, restore } = makeEnv();
  try {
    const res = await worker.fetch(new Request("https://worker.test/api/manifest"), env);
    assert.equal(res.status, 401);
  } finally {
    restore();
  }
});

test("content round-trips with manifest listing", async () => {
  const { env, restore } = makeEnv();
  try {
    const put = await worker.fetch(req("/api/content/blog/hello.md", "PUT", "---\ntitle: Hi\n---\nBody"), env);
    assert.equal(put.status, 200);
    const manifest = await (await worker.fetch(req("/api/manifest"), env)).json();
    assert.deepEqual(manifest, { keys: ["blog/hello.md"] });
    const got = await worker.fetch(req("/api/content/blog/hello.md"), env);
    assert.equal(await got.text(), "---\ntitle: Hi\n---\nBody");
    const del = await worker.fetch(req("/api/content/blog/hello.md", "DELETE"), env);
    assert.equal(del.status, 200);
    const missing = await worker.fetch(req("/api/content/blog/hello.md"), env);
    assert.equal(missing.status, 404);
  } finally {
    restore();
  }
});

test("images listing skips content store and build metadata", async () => {
  const { env, bucket, restore } = makeEnv();
  try {
    await bucket.put("content/blog/a.md", "x");
    await bucket.put("meta/build.json", "{}");
    await bucket.put("images/cover.webp", "img");
    await bucket.put("og/hello.webp", "img");
    const res = await worker.fetch(req("/api/images"), env);
    const data = (await res.json()) as { images: Array<{ key: string }> };
    assert.deepEqual(
      data.images.map((i) => i.key).sort(),
      ["images/cover.webp", "og/hello.webp"]
    );
  } finally {
    restore();
  }
});

test("build trigger records ok status, failure records error", async () => {
  const good = makeEnv();
  try {
    const res = await worker.fetch(req("/api/build", "POST"), good.env);
    assert.equal(res.status, 200);
    const status = (await (await worker.fetch(req("/api/status"), good.env)).json()) as Record<string, unknown>;
    assert.equal(status.lastBuildStatus, "ok");
    assert.ok(status.lastBuildAt);
  } finally {
    good.restore();
  }

  const bad = makeEnv(async () => ({ ok: false, status: 500 }));
  try {
    const res = await worker.fetch(req("/api/build", "POST"), bad.env);
    assert.equal(res.status, 502);
    const status = (await (await worker.fetch(req("/api/status"), bad.env)).json()) as Record<string, unknown>;
    assert.equal(status.lastBuildStatus, "error");
  } finally {
    bad.restore();
  }
});

test("cron skips idle ticks without reading any files", async () => {
  const { env, bucket, calls, restore } = makeEnv();
  const old = new Date(Date.now() - 60_000);
  try {
    await bucket.put("content/blog/a.md", "---\ntitle: A\n---\nBody", old);
    // First tick performs the scan (one GET) and records no due date.
    assert.equal(await shouldRebuild(env), true);
    assert.equal(bucket.gets, 1); // the post read (build meta was absent)
    // A build runs, stamping lastBuildAt; the next tick is fully idle.
    await worker.fetch(req("/api/build", "POST"), env);
    bucket.gets = 0;
    assert.equal(await shouldRebuild(env), false);
    assert.equal(bucket.gets, 1); // only the build meta read
    assert.equal(calls.length, 1); // the single build-hook call above
  } finally {
    restore();
  }
});

test("cron fires once a scheduled post becomes due", async () => {
  const { env, bucket, calls, restore } = makeEnv();
  const future = new Date(Date.now() + 60_000).toISOString();
  const old = new Date(Date.now() - 60_000);
  try {
    await bucket.put("content/blog/soon.md", `---\ntitle: Soon\npublished_at: "${future}"\n---\nBody`, old);
    assert.equal(await shouldRebuild(env), true); // fresh upload
    const meta = JSON.parse((await bucket.get("meta/build.json"))!.body as string) as Record<string, unknown>;
    assert.equal(meta.nextDueAt, future);
    // A build runs; while the post is still pending and nothing is new, skip.
    await worker.fetch(req("/api/build", "POST"), env);
    bucket.gets = 0;
    assert.equal(await shouldRebuild(env), false);
    assert.equal(bucket.gets, 1); // only the build meta read
    // Simulate time passing by rewriting the post as already due.
    const past = new Date(Date.now() - 60_000).toISOString();
    await bucket.put("content/blog/soon.md", `---\ntitle: Soon\npublished_at: "${past}"\n---\nBody`);
    assert.equal(await shouldRebuild(env), true);
    await worker.scheduled({} as never, env, { waitUntil: (p: Promise<unknown>) => { void p; } } as never);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(calls.includes("https://hooks.example.com/build"));
  } finally {
    restore();
  }
});
