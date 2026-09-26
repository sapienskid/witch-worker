import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { applyDraftLogic, deepMerge, ensureAnchors, isEmptyValue, reconcile } from "./sync-content.js";

function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-fx-"));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}

test("reconcile keeps nested manifest files and removes the rest", () => {
  const dir = fixture({
    "blog/keep.md": "keep",
    "blog/drop.md": "drop",
    "about/_index.md": "about",
    "stray.md": "stray",
  });
  try {
    const removed = reconcile(dir, dir, new Set(["blog/keep.md", "about/_index.md"]));
    assert.equal(removed, 2);
    assert.ok(fs.existsSync(path.join(dir, "blog/keep.md")));
    assert.ok(fs.existsSync(path.join(dir, "about/_index.md")));
    assert.ok(!fs.existsSync(path.join(dir, "blog/drop.md")));
    assert.ok(!fs.existsSync(path.join(dir, "stray.md")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reconcile keeps anchors and prunes emptied dirs", () => {
  const dir = fixture({ "portfolio/_index.md": "anchor", "blog/old.md": "old" });
  try {
    const removed = reconcile(dir, dir, new Set(["portfolio/_index.md"]));
    assert.equal(removed, 1);
    assert.ok(fs.existsSync(path.join(dir, "portfolio/_index.md")));
    assert.ok(!fs.existsSync(path.join(dir, "blog")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureAnchors creates titled section pages idempotently", () => {
  const dir = fixture({});
  try {
    ensureAnchors(dir, ["portfolio/_index.md"]);
    const body = fs.readFileSync(path.join(dir, "portfolio/_index.md"), "utf8");
    assert.ok(body.includes('title: "Portfolio"'));
    assert.ok(body.includes("draft: false"));
    ensureAnchors(dir, ["portfolio/_index.md"]);
    assert.ok(fs.existsSync(path.join(dir, "portfolio/_index.md")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("applyDraftLogic hides future-dated posts", () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  const out = applyDraftLogic(`---\ntitle: T\ndraft: false\npublished_at: "${future}"\n---\nBody`);
  assert.match(out, /^draft: true/m);
  const past = new Date(Date.now() - 60_000).toISOString();
  const live = applyDraftLogic(`---\ntitle: T\ndraft: true\npublished_at: "${past}"\n---\nBody`);
  assert.match(live, /^draft: false/m);
});

test("deepMerge ignores blank CMS values", () => {
  const merged = deepMerge({ a: "keep", b: "x", nested: { c: 1 } }, { a: "", b: "y", nested: {} });
  assert.deepEqual(merged, { a: "keep", b: "y", nested: { c: 1 } });
  assert.ok(isEmptyValue("  ") && isEmptyValue([]) && isEmptyValue({}) && !isEmptyValue("v"));
});
