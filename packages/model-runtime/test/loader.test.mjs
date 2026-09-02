/**
 * Node 22 内置测试：loadAssets 的可控 fetch / Cache 替身。
 * 覆盖预分配进度 loaded/total、cache/network/mixed、overflow/underflow、
 * 坏 cache 删除、cache 写失败不阻断。
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { loadAssets } from "../src/loader.ts";
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
