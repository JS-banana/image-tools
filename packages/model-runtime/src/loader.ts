// Browser + dedicated Worker asset store. Deployment URLs and cache ownership are explicit.
import { assetCacheKey } from "./manifest.ts";
import type { AssetFile, ModelLoadProgress } from "./types.ts";

export interface AssetLoadResult {
  files: Record<string, ArrayBuffer>;
  source: "cache" | "network" | "mixed";
}
export type AssetLoader = (
  files: Readonly<Record<string, AssetFile>>,
  revision: string,
  onProgress?: (progress: ModelLoadProgress) => void,
  signal?: AbortSignal,
) => Promise<AssetLoadResult>;

export interface AssetStoreOptions {
  /** Owned by one tool, e.g. image-tools-ocr-v1; pruning never touches other caches. */
  namespace: string;
  /** Site/CDN base including deployment path, e.g. https://host/image-tools/. */
  baseURL?: string;
  /** Overrides baseURL; receives the catalog's logical URL without revision. */
  resolveURL?: (url: string) => string;
}
export interface AssetStore {
  loadAssets: AssetLoader;
  /** Supply cacheKey(url, revision) for this tool's complete catalog, never a selected model. */
  prune(validCacheKeys: ReadonlySet<string>): Promise<void>;
  cacheKey(url: string, revision: string): string;
}

function checkAbort(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}
function warn(message: string, error: unknown): void {
  console.warn(`[loader] ${message}:`, error instanceof Error ? error.message : String(error));
}

/** Resolve a logical path against a deployment base, preserving its pathname prefix. */
export function resolveAssetURL(url: string, options: Pick<AssetStoreOptions, "baseURL" | "resolveURL">): string {
  if (options.resolveURL) return options.resolveURL(url);
  if (!options.baseURL || /^https?:\/\//i.test(url)) return url;
  const base = options.baseURL.replace(/\/+$/, "");
  return `${base}/${url.replace(/^\/+/, "")}`;
}

async function getCache(namespace: string): Promise<Cache | null> {
  if (!("caches" in globalThis)) return null;
  try { return await globalThis.caches.open(namespace); }
  catch (error) { warn("Cache API 不可用", error); return null; }
}

async function fetchNetwork(
  file: AssetFile,
  key: string,
  cache: Cache | null,
  signal: AbortSignal,
  onBytes: (loaded: number, fromCache: boolean) => void,
): Promise<ArrayBuffer> {
  checkAbort(signal);
  const resp = await fetch(key, { signal });
  if (!resp.ok) throw new Error(`下载失败 HTTP ${resp.status}: ${key}`);
  const expected = file.sizeBytes;
  const bytes = new Uint8Array(expected);
  let offset = 0;
  const append = (chunk: Uint8Array) => {
    checkAbort(signal);
    if (offset + chunk.byteLength > expected) {
      throw new Error(`资产字节溢出 (network): ${file.url} 已读 ${offset + chunk.byteLength} > 声明 sizeBytes ${expected}`);
    }
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
    onBytes(offset, false);
  };
  if (!resp.body) {
    append(new Uint8Array(await resp.arrayBuffer()));
  } else {
    const reader = resp.body.getReader();
    const cancel = () => { void reader.cancel(signal.reason).catch(() => undefined); };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      checkAbort(signal);
      for (;;) {
        const { done, value } = await reader.read();
        checkAbort(signal);
        if (done) break;
        append(value);
      }
    } catch (error) {
      await reader.cancel(error).catch(() => undefined);
      throw error;
    } finally {
      signal.removeEventListener("abort", cancel);
      reader.releaseLock();
    }
  }
  checkAbort(signal);
  if (offset !== expected) {
    throw new Error(`资产字节不足 (network): ${file.url} 实际 ${offset} ≠ 声明 sizeBytes ${expected}`);
  }
  if (cache) {
    try { await cache.put(key, new Response(bytes)); }
    catch (error) { warn("缓存写入失败", error); }
  }
  checkAbort(signal);
  return bytes.buffer;
}

async function loadOne(
  file: AssetFile,
  key: string,
  cache: Cache | null,
  signal: AbortSignal,
  onBytes: (loaded: number, fromCache: boolean) => void,
): Promise<{ buffer: ArrayBuffer; fromCache: boolean }> {
  checkAbort(signal);
  if (cache) {
    try {
      const hit = await cache.match(key);
      checkAbort(signal);
      if (hit) {
        const buffer = await hit.arrayBuffer();
        checkAbort(signal);
        if (buffer.byteLength === file.sizeBytes) {
          onBytes(buffer.byteLength, true);
          return { buffer, fromCache: true };
        }
        console.warn(`[loader] 缓存字节错配，删除后重取: ${file.url} ${buffer.byteLength} ≠ ${file.sizeBytes}`);
        try { await cache.delete(key); }
        catch (error) { warn("坏缓存删除失败", error); }
      }
    } catch (error) {
      checkAbort(signal);
      warn("缓存读取失败，改用网络", error);
    }
  }
  return { buffer: await fetchNetwork(file, key, cache, signal, onBytes), fromCache: false };
}

export function createAssetStore(options: AssetStoreOptions): AssetStore {
  if (!options.namespace.trim()) throw new Error("Asset cache namespace must be non-empty");
  const cacheKey = (url: string, revision: string) => assetCacheKey(resolveAssetURL(url, options), revision);
  const loadAssets: AssetLoader = async (files, revision, onProgress, signal) => {
    checkAbort(signal);
    const entries = Object.entries(files);
    for (const [, file] of entries) {
      if (!Number.isSafeInteger(file.sizeBytes) || file.sizeBytes <= 0) throw new Error("Asset sizeBytes must be a positive safe integer");
    }
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const totalBytes = entries.reduce((sum, [, f]) => sum + f.sizeBytes, 0);
    const loadedPerKey = new Map<string, number>();
    let firstError: unknown;
    let failed = false;
    try {
      const cache = await getCache(options.namespace);
      checkAbort(controller.signal);
      const results = await Promise.allSettled(entries.map(async ([key, file]) => {
        try {
          const result = await loadOne(file, cacheKey(file.url, revision), cache, controller.signal, (loaded, fromCache) => {
            loadedPerKey.set(key, loaded);
            const loadedBytes = entries.reduce((sum, [name, asset]) => sum + Math.min(loadedPerKey.get(name) ?? 0, asset.sizeBytes), 0);
            onProgress?.({ pct: totalBytes ? Math.min(100, loadedBytes / totalBytes * 100) : null, label: fromCache ? "读取本机缓存" : `下载 ${key}`, fromCache, loadedBytes, totalBytes });
          });
          return [key, result] as const;
        } catch (error) {
          if (!failed) { failed = true; firstError = error; controller.abort(error); }
          throw error;
        }
      }));
      if (failed) throw firstError;
      checkAbort(controller.signal);
      const out: Record<string, ArrayBuffer> = {};
      let cacheHits = 0;
      for (const result of results) {
        if (result.status !== "fulfilled") throw result.reason;
        const [key, asset] = result.value;
        out[key] = asset.buffer;
        if (asset.fromCache) cacheHits++;
      }
      return { files: out, source: cacheHits === entries.length ? "cache" : cacheHits === 0 ? "network" : "mixed" };
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  };
  const prune = async (validCacheKeys: ReadonlySet<string>): Promise<void> => {
    const cache = await getCache(options.namespace);
    if (!cache) return;
    const resolved = validCacheKeys;
    try {
      const keys = await cache.keys();
      await Promise.all(keys.map(async (req) => {
        const url = typeof req === "string" ? req : req.url;
        let relative = url;
        try { const u = new URL(url); relative = u.pathname + u.search; } catch { /* logical path */ }
        if (!resolved.has(url) && !resolved.has(relative)) await cache.delete(req);
      }));
    } catch (error) { warn("缓存清理失败", error); }
  };
  return { loadAssets, prune, cacheKey };
}
