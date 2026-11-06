/**
 * Node 22 内置测试：loadAssets 的可控 fetch / Cache 替身。
 * 覆盖预分配进度 loaded/total、cache/network/mixed、overflow/underflow、
 * 坏 cache 删除、cache 写失败不阻断。
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { createAssetStore, resolveAssetURL } from "../src/loader.ts";
const { loadAssets } = createAssetStore({ namespace: "test-assets" });
import { assetCacheKey } from "../src/manifest.ts";

const ORIGINALS = {
  hasWindow: Object.prototype.hasOwnProperty.call(globalThis, "window"),
  window: globalThis.window,
  hasCaches: Object.prototype.hasOwnProperty.call(globalThis, "caches"),
  caches: globalThis.caches,
  fetch: globalThis.fetch,
};

function restoreGlobals() {
  if (ORIGINALS.hasWindow) globalThis.window = ORIGINALS.window;
  else delete globalThis.window;
  if (ORIGINALS.hasCaches) globalThis.caches = ORIGINALS.caches;
  else delete globalThis.caches;
  globalThis.fetch = ORIGINALS.fetch;
}

function streamBody(chunks) {
  const queue = chunks.map((c) => (c instanceof Uint8Array ? c : new Uint8Array(c)));
  let i = 0;
  return {
    getReader() {
      return {
        async cancel() {},
        releaseLock() {},
        async read() {
          if (i >= queue.length) return { done: true, value: undefined };
          return { done: false, value: queue[i++] };
        },
      };
    },
  };
}

function okStream(bytes, chunks) {
  const raw = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const parts = chunks ?? [raw];
  return {
    ok: true,
    status: 200,
    body: streamBody(parts),
  };
}

function httpError(status) {
  return { ok: false, status, body: null };
}

class MemoryCache {
  constructor() {
    this.store = new Map();
    this.deleted = [];
    this.putError = null;
    this.putCount = 0;
  }

  async match(key) {
    const buf = this.store.get(key);
    if (!buf) return undefined;
    return {
      async arrayBuffer() {
        return buf.slice(0);
      },
    };
  }

  async put(key, response) {
    this.putCount += 1;
    if (this.putError) throw this.putError;
    this.store.set(key, await response.arrayBuffer());
  }

  async delete(key) {
    this.deleted.push(key);
    return this.store.delete(key);
  }

  async keys(url, options = {}) {
    return [...this.store.keys()].filter((key) => {
      if (!url) return true;
      const candidate = new URL(key, "https://example.test");
      const requested = new URL(url, "https://example.test");
      return candidate.origin === requested.origin && candidate.pathname === requested.pathname &&
        (options.ignoreSearch || candidate.search === requested.search);
    });
  }
}

function installCache(cache) {
  const cachesObj = {
    async open() {
      return cache;
    },
  };
  globalThis.window = { caches: cachesObj };
  globalThis.caches = cachesObj;
}

function installFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return handler(String(url), calls.length);
  };
  return calls;
}

const FILE_A = { url: "/models/a.bin", sizeBytes: 4 };
const FILE_B = { url: "/models/b.bin", sizeBytes: 6 };
const REV = "r1";
const KEY_A = assetCacheKey(FILE_A.url, REV);
const KEY_B = assetCacheKey(FILE_B.url, REV);
const BYTES_A = new Uint8Array([1, 2, 3, 4]);
const BYTES_B = new Uint8Array([9, 8, 7, 6, 5, 4]);

function assertProgressShape(p) {
  assert.equal(typeof p.label, "string");
  assert.equal(typeof p.fromCache, "boolean");
  assert.equal(typeof p.loadedBytes, "number");
  assert.equal(typeof p.totalBytes, "number");
  assert.ok(p.loadedBytes >= 0);
  assert.ok(p.loadedBytes <= p.totalBytes);
  assert.ok(p.pct === null || (typeof p.pct === "number" && p.pct >= 0 && p.pct <= 100));
}

describe("loadAssets", () => {
  afterEach(restoreGlobals);

  it("reports preallocated totalBytes and streaming loadedBytes from declared size", async () => {
    installFetch((url) => {
      assert.equal(url, KEY_A);
      return okStream(BYTES_A, [BYTES_A.subarray(0, 2), BYTES_A.subarray(2)]);
    });

    const progress = [];
    const result = await loadAssets({ model: FILE_A }, REV, (p) => {
      progress.push({ ...p });
    });

    assert.equal(result.source, "network");
    assert.deepEqual(new Uint8Array(result.files.model), BYTES_A);
    assert.ok(progress.length >= 2, `expected streamed progress, got ${progress.length}`);
    for (const p of progress) {
      assertProgressShape(p);
      assert.equal(p.totalBytes, FILE_A.sizeBytes);
      assert.equal(p.fromCache, false);
    }
    assert.ok(
      progress.some((p) => p.loadedBytes === 2 && p.totalBytes === 4),
      `expected a mid-stream 2/4 report, got ${JSON.stringify(progress)}`,
    );
    const last = progress[progress.length - 1];
    assert.equal(last.loadedBytes, FILE_A.sizeBytes);
    assert.equal(last.totalBytes, FILE_A.sizeBytes);
    assert.equal(last.pct, 100);
  });

  it("loads from network when Cache API is absent", async () => {
    const calls = installFetch((url) => {
      assert.equal(url, KEY_A);
      return okStream(BYTES_A);
    });
    const result = await loadAssets({ model: FILE_A }, REV);
    assert.equal(result.source, "network");
    assert.deepEqual(new Uint8Array(result.files.model), BYTES_A);
    assert.equal(calls.length, 1);
  });

  it("returns cache source on a full hit and does not refetch", async () => {
    const cache = new MemoryCache();
    cache.store.set(KEY_A, BYTES_A.buffer.slice(0));
    installCache(cache);
    const calls = installFetch(() => {
      throw new Error("cache hit must not fetch");
    });

    const progress = [];
    const result = await loadAssets({ model: FILE_A }, REV, (p) => progress.push({ ...p }));
    assert.equal(result.source, "cache");
    assert.deepEqual(new Uint8Array(result.files.model), BYTES_A);
    assert.equal(calls.length, 0);
    assert.ok(progress.length >= 1);
    for (const p of progress) {
      assertProgressShape(p);
      assert.equal(p.fromCache, true);
      assert.equal(p.loadedBytes, FILE_A.sizeBytes);
      assert.equal(p.totalBytes, FILE_A.sizeBytes);
    }
  });

  it("returns mixed source when some files hit cache and others fetch", async () => {
    const cache = new MemoryCache();
    cache.store.set(KEY_A, BYTES_A.buffer.slice(0));
    installCache(cache);
    const calls = installFetch((url) => {
      assert.equal(url, KEY_B);
      return okStream(BYTES_B);
    });

    const result = await loadAssets({ a: FILE_A, b: FILE_B }, REV);
    assert.equal(result.source, "mixed");
    assert.deepEqual(new Uint8Array(result.files.a), BYTES_A);
    assert.deepEqual(new Uint8Array(result.files.b), BYTES_B);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls, [KEY_B]);
  });

  it("writes a successful network fetch into cache for the next load", async () => {
    const cache = new MemoryCache();
    installCache(cache);
    const calls = installFetch(() => okStream(BYTES_A));

    const first = await loadAssets({ model: FILE_A }, REV);
    assert.equal(first.source, "network");
    assert.equal(calls.length, 1);
    assert.equal(cache.putCount, 1);

    const second = await loadAssets({ model: FILE_A }, REV);
    assert.equal(second.source, "cache");
    assert.deepEqual(new Uint8Array(second.files.model), BYTES_A);
    assert.equal(calls.length, 1);
  });

  it("rejects overflowed network bytes before returning a buffer", async () => {
    installFetch(() =>
      okStream(new Uint8Array([1, 2, 3, 4, 5]), [
        new Uint8Array([1, 2, 3]),
        new Uint8Array([4, 5]),
      ]),
    );
    await assert.rejects(
      () => loadAssets({ model: FILE_A }, REV),
      (err) => {
        assert.match(String(err.message), /溢出/);
        assert.match(String(err.message), /sizeBytes/);
        return true;
      },
    );
  });

  it("rejects underflowed network bytes before returning a buffer", async () => {
    installFetch(() => okStream(new Uint8Array([1, 2]), [new Uint8Array([1, 2])]));
    await assert.rejects(
      () => loadAssets({ model: FILE_A }, REV),
      (err) => {
        assert.match(String(err.message), /不足/);
        assert.match(String(err.message), /sizeBytes/);
        return true;
      },
    );
  });

  it("deletes a size-mismatched cache entry and refetches from network", async () => {
    const cache = new MemoryCache();
    cache.store.set(KEY_A, new Uint8Array([9, 9]).buffer.slice(0));
    installCache(cache);
    const calls = installFetch(() => okStream(BYTES_A));

    const result = await loadAssets({ model: FILE_A }, REV);
    assert.equal(result.source, "network");
    assert.deepEqual(new Uint8Array(result.files.model), BYTES_A);
    assert.deepEqual(cache.deleted, [KEY_A]);
    assert.equal(calls.length, 1);
    assert.equal(cache.store.get(KEY_A)?.byteLength, FILE_A.sizeBytes);
  });

  it("still returns network bytes when cache.put throws", async () => {
    const cache = new MemoryCache();
    cache.putError = new Error("quota exceeded");
    installCache(cache);
    const calls = installFetch(() => okStream(BYTES_A));

    const first = await loadAssets({ model: FILE_A }, REV);
    assert.equal(first.source, "network");
    assert.deepEqual(new Uint8Array(first.files.model), BYTES_A);
    assert.equal(cache.putCount, 1);
    assert.equal(cache.store.size, 0);

    const second = await loadAssets({ model: FILE_A }, REV);
    assert.equal(second.source, "network");
    assert.deepEqual(new Uint8Array(second.files.model), BYTES_A);
    assert.equal(calls.length, 2);
  });

  it("surfaces HTTP download failures", async () => {
    installFetch(() => httpError(404));
    await assert.rejects(
      () => loadAssets({ model: FILE_A }, REV),
      /下载失败 HTTP 404/,
    );
  });
});

describe("tool-owned Worker asset stores", () => {
  it("uses CacheStorage without a window and resolves base URLs before cache lookup", async () => {
    const cache = new MemoryCache();
    const opened = [];
    delete globalThis.window;
    globalThis.caches = { open: async (name) => { opened.push(name); return cache; } };
    const store = createAssetStore({ namespace: "tool-a-v1", baseURL: "https://example.test/image-tools/" });
    const key = store.cacheKey("/models/a.bin", "r1");
    assert.equal(key, "https://example.test/image-tools/models/a.bin?rev=r1");
    cache.store.set(key, new Uint8Array([1, 2]).buffer);
    globalThis.fetch = async () => { throw new Error("unexpected network request"); };
    const loaded = await store.loadAssets({ model: { url: "/models/a.bin", sizeBytes: 2 } }, "r1");
    assert.equal(loaded.source, "cache");
    assert.deepEqual(opened, ["tool-a-v1"]);
    assert.equal(resolveAssetURL("/models/a", { resolveURL: (url) => `https://cdn.test${url}` }), "https://cdn.test/models/a");
  });

  it("prunes only the chosen tool namespace using exactly the resolved revision keys", async () => {
    const caches = new Map();
    globalThis.caches = { open: async (name) => caches.get(name) };
    const a = new MemoryCache();
    const b = new MemoryCache();
    a.keys = async () => [...a.store.keys()].map((url) => new Request(url));
    a.delete = async (req) => a.store.delete(typeof req === "string" ? req : req.url);
    caches.set("tool-a", a); caches.set("tool-b", b);
    const store = createAssetStore({ namespace: "tool-a", resolveURL: (url) => `https://assets.test${url}` });
    const keep = store.cacheKey("/models/a", "new");
    const stale = store.cacheKey("/models/a", "old");
    a.store.set(keep, new ArrayBuffer(1)); a.store.set(stale, new ArrayBuffer(1));
    b.store.set("https://assets.test/models/b?rev=other", new ArrayBuffer(1));
    await store.prune(new Set([keep]));
    assert.deepEqual([...a.store.keys()], [keep]);
    assert.equal(b.store.size, 1);
  });

  it("falls back to network when cache reading is denied", async () => {
    installCache({ match: async () => { throw new Error("security error"); }, put: async () => {} });
    installFetch(() => okStream([1, 2]));
    const loaded = await loadAssets({ a: { url: "/models/a", sizeBytes: 2 } }, "r");
    assert.equal(loaded.source, "network");
  });

  it("aborts an in-progress body and never caches a partial model", async () => {
    const cache = new MemoryCache(); installCache(cache);
    const controller = new AbortController();
    let cancelled = false;
    let fetchSignal;
    globalThis.fetch = async (_url, options) => {
      fetchSignal = options.signal;
      return new Response(new ReadableStream({
        start(stream) { stream.enqueue(new Uint8Array([1])); },
        cancel() { cancelled = true; },
      }));
    };
    await assert.rejects(loadAssets({ a: { url: "/models/a", sizeBytes: 3 } }, "r", (progress) => {
      if (progress.loadedBytes === 1) controller.abort(new DOMException("cancelled", "AbortError"));
    }, controller.signal), { name: "AbortError" });
    assert.ok(fetchSignal.aborted);
    assert.ok(cancelled);
    assert.equal(cache.putCount, 0);
  });

  it("cancels sibling downloads when one asset fails", async () => {
    delete globalThis.caches;
    let siblingSignal;
    globalThis.fetch = async (url, options) => {
      if (url.includes("bad")) return { ok: false, status: 503 };
      siblingSignal = options.signal;
      return new Response(new ReadableStream({ start() {} }));
    };
    await assert.rejects(loadAssets({ bad: { url: "/models/bad", sizeBytes: 1 }, other: { url: "/models/other", sizeBytes: 1 } }, "r"), /503/);
    assert.equal(siblingSignal.aborted, true);
  });

  it("rejects an already cancelled request before any network call", async () => {
    const controller = new AbortController(); controller.abort();
    let called = false;
    globalThis.fetch = async () => { called = true; throw new Error("unexpected"); };
    await assert.rejects(loadAssets({ a: { url: "/models/a", sizeBytes: 1 } }, "r", undefined, controller.signal), { name: "AbortError" });
    assert.equal(called, false);
  });
});

describe("legacy model cache upgrades", () => {
  afterEach(restoreGlobals);

  const oldKey = assetCacheKey(FILE_A.url, "old-revision");
  const otherKey = assetCacheKey("/models/other-tool/model.onnx", "other-revision");
  const file = { ...FILE_A, sha256: "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a" };

  function setup() {
    const legacy = new MemoryCache();
    const current = new MemoryCache();
    legacy.store.set(oldKey, BYTES_A.buffer.slice(0));
    legacy.store.set(otherKey, BYTES_B.buffer.slice(0));
    globalThis.caches = { open: async (name) => name === "legacy" ? legacy : current };
    const store = createAssetStore({
      namespace: "current", legacyNamespace: "legacy", baseURL: "https://example.test/image-tools/",
    });
    return { legacy, current, store, key: store.cacheKey(file.url, REV) };
  }

  it("reuses verified legacy bytes across namespace, revision and deployment-prefix changes", async () => {
    const { legacy, current, store, key } = setup();
    const calls = installFetch(() => { throw new Error("cached upgrade must work offline"); });
    const result = await store.loadAssets({ model: file }, REV);
    assert.equal(result.source, "cache");
    assert.deepEqual(new Uint8Array(result.files.model), BYTES_A);
    assert.deepEqual(calls, []);
    assert.deepEqual(new Uint8Array(current.store.get(key)), BYTES_A);
    assert.equal(legacy.store.has(oldKey), false);
    assert.equal(legacy.store.has(otherKey), true, "the other tool's legacy cache must survive");
  });

  it("does not promote same-size legacy bytes with a different digest", async () => {
    const { legacy, store } = setup();
    legacy.store.set(oldKey, new Uint8Array([4, 3, 2, 1]).buffer);
    const calls = installFetch(() => okStream(BYTES_A));
    const result = await store.loadAssets({ model: file }, REV);
    assert.equal(result.source, "network");
    assert.equal(calls.length, 1);
    assert.equal(legacy.store.has(oldKey), true, "a different model revision must not be deleted");
  });

  it("retains usable legacy bytes if promotion exceeds the cache quota", async () => {
    const { legacy, current, store } = setup();
    current.putError = new Error("quota exceeded");
    installFetch(() => { throw new Error("legacy bytes must remain usable"); });
    const result = await store.loadAssets({ model: file }, REV);
    assert.equal(result.source, "cache");
    assert.deepEqual(new Uint8Array(result.files.model), BYTES_A);
    assert.equal(legacy.store.has(oldKey), true);
    assert.equal(current.store.size, 0);
  });

  it("requires an expected digest before reusing an unknown legacy revision", async () => {
    const { legacy, store } = setup();
    const calls = installFetch(() => okStream(BYTES_A));
    const result = await store.loadAssets({ model: FILE_A }, REV);
    assert.equal(result.source, "network");
    assert.equal(calls.length, 1);
    assert.equal(legacy.store.has(oldKey), true);
  });

  it("finds matching bytes among old revisions without deleting a different revision", async () => {
    const { legacy, store } = setup();
    legacy.store.set(oldKey, new Uint8Array([4, 3, 2, 1]).buffer);
    const matchingKey = assetCacheKey(FILE_A.url, "matching-revision");
    legacy.store.set(matchingKey, BYTES_A.buffer.slice(0));
    installFetch(() => { throw new Error("matching legacy revision must not fetch"); });
    const result = await store.loadAssets({ model: file }, REV);
    assert.equal(result.source, "cache");
    assert.equal(legacy.store.has(oldKey), true);
    assert.equal(legacy.store.has(matchingKey), false);
  });

  it("cancels a legacy read without promoting or deleting its bytes", async () => {
    const { legacy, current, store } = setup();
    const controller = new AbortController();
    const match = legacy.match.bind(legacy);
    legacy.match = async (key) => {
      const response = await match(key);
      controller.abort(new DOMException("cancelled", "AbortError"));
      return response;
    };
    installFetch(() => { throw new Error("cancelled upgrade must not fetch"); });
    await assert.rejects(store.loadAssets({ model: file }, REV, undefined, controller.signal), { name: "AbortError" });
    assert.equal(legacy.store.has(oldKey), true);
    assert.equal(current.putCount, 0);
  });
});
