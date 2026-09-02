// 通用资产加载：Cache API + revision 键 + 纯字节；不解析 dict、不理解模型结构
import { assetCacheKey, withBasePath } from "./manifest.ts";
import type { AssetFile, ModelLoadProgress } from "./types.ts";

const CACHE_NAME = "ocr-models-v1";

async function getCache(): Promise<Cache | null> {
  if (typeof window === "undefined" || !("caches" in window)) return null;
  try {
    return await caches.open(CACHE_NAME);
  } catch (e) {
    console.warn("[loader] Cache API 不可用:", (e as Error).message);
    return null;
  }
}

async function fetchNetwork(
  file: AssetFile,
  key: string,
  cache: Cache | null,
  onBytes?: (loaded: number, fromCache: boolean) => void,
): Promise<ArrayBuffer> {
  if (typeof navigator !== "undefined" && navigator.storage?.estimate) {
    try {
      const { quota, usage } = await navigator.storage.estimate();
      if (quota && usage !== undefined && quota - usage < 50 * 1024 * 1024) {
        console.warn(
          "[loader] 存储剩余空间不足:",
          Math.round((quota - usage) / 1048576),
          "MB",
        );
      }
    } catch {
      /* 忽略 */
    }
  }

  const url = withBasePath(key);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`下载失败 HTTP ${resp.status}: ${url}`);

  const expected = file.sizeBytes;
  const bytes = new Uint8Array(expected);
  let offset = 0;

  const append = (chunk: Uint8Array) => {
    if (offset + chunk.byteLength > expected) {
      throw new Error(
        `资产字节溢出 (network): ${file.url} 已读 ${offset + chunk.byteLength} > 声明 sizeBytes ${expected}`,
      );
    }
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
    onBytes?.(offset, false);
  };

  if (!resp.body) {
    append(new Uint8Array(await resp.arrayBuffer()));
  } else {
    const reader = resp.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      append(value);
    }
  }

  if (offset !== expected) {
    throw new Error(
      `资产字节不足 (network): ${file.url} 实际 ${offset} ≠ 声明 sizeBytes ${expected}`,
    );
  }

  if (cache) {
    try {
      await cache.put(key, new Response(bytes));
    } catch (e) {
      console.warn("[loader] 缓存写入失败:", (e as Error).message);
    }
  }
  return bytes.buffer;
}

async function loadOne(
  file: AssetFile,
  revision: string,
  onBytes?: (loaded: number, fromCache: boolean) => void,
): Promise<{ buffer: ArrayBuffer; fromCache: boolean }> {
  const key = assetCacheKey(file.url, revision);
  const cache = await getCache();

  if (cache) {
    const hit = await cache.match(key);
    if (hit) {
      const buffer = await hit.arrayBuffer();
      if (buffer.byteLength === file.sizeBytes) {
        onBytes?.(buffer.byteLength, true);
        return { buffer, fromCache: true };
      }
      // 坏 cache：删除后走网络重取
      console.warn(
        `[loader] 缓存字节错配，删除后重取: ${file.url} ` +
          `${buffer.byteLength} ≠ ${file.sizeBytes}`,
      );
      try {
        await cache.delete(key);
      } catch (e) {
        console.warn("[loader] 坏缓存删除失败:", (e as Error).message);
      }
    }
  }

  const buffer = await fetchNetwork(file, key, cache, onBytes);
  return { buffer, fromCache: false };
}

/**
 * 按文件描述加载字节。cache key = url?rev=revision。
 * 进度按 sizeBytes 加权；无法确定总大小时 pct 为 null。
 * 最终 buffer.byteLength 必须等于声明 sizeBytes。
 */
export async function loadAssets(
  files: Readonly<Record<string, AssetFile>>,
  revision: string,
  onProgress?: (progress: ModelLoadProgress) => void,
): Promise<{
  files: Record<string, ArrayBuffer>;
  source: "cache" | "network" | "mixed";
}> {
  const entries = Object.entries(files);
  const totalKnown = entries.reduce((s, [, f]) => s + f.sizeBytes, 0);
  const out: Record<string, ArrayBuffer> = {};
  let cacheHits = 0;
  let networkGets = 0;
  const loadedPerKey: Record<string, number> = {};

  const report = (label: string, fromCache: boolean) => {
    if (!onProgress) return;
    let loadedBytes = 0;
    for (const [k, f] of entries) {
      loadedBytes += Math.min(loadedPerKey[k] ?? 0, f.sizeBytes);
    }
    const totalBytes = totalKnown;
    onProgress({
      pct:
        totalBytes > 0
          ? Math.min(100, (loadedBytes / totalBytes) * 100)
          : null,
      label,
      fromCache,
      loadedBytes,
      totalBytes,
    });
  };

  await Promise.all(
    entries.map(async ([key, file]) => {
      const label = `下载 ${key}`;
      const result = await loadOne(file, revision, (loaded, fromCache) => {
        loadedPerKey[key] = loaded;
        report(fromCache ? "读取本机缓存" : label, fromCache);
      });
      loadedPerKey[key] = file.sizeBytes;
      out[key] = result.buffer;
      if (result.fromCache) cacheHits++;
      else networkGets++;
      report(result.fromCache ? "读取本机缓存" : label, result.fromCache);
    }),
  );

  let source: "cache" | "network" | "mixed";
  if (networkGets === 0) source = "cache";
  else if (cacheHits === 0) source = "network";
  else source = "mixed";

  return { files: out, source };
}

/** 按整份 catalog 有效 key 集合清理；不在集合内的条目删除 */
export async function pruneAssetCache(
  validCacheKeys: ReadonlySet<string>,
): Promise<void> {
  const cache = await getCache();
  if (!cache) return;
  try {
    const keys = await cache.keys();
    await Promise.all(
      keys.map(async (req) => {
        const keyUrl = typeof req === "string" ? req : req.url;
        // Cache API 可能存绝对 URL；用 pathname+search 或完整串比对
        let rel = keyUrl;
        try {
          const u = new URL(keyUrl, "http://localhost");
          rel = u.pathname + u.search;
        } catch {
          /* keep */
        }
        if (!validCacheKeys.has(rel) && !validCacheKeys.has(keyUrl)) {
          await cache.delete(req);
        }
      }),
    );
  } catch (e) {
    console.warn("[loader] 缓存清理失败:", (e as Error).message);
  }
}
