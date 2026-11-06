import type { AssetFile, AssetModelEntry, ModelSummary, ValidatedModelCatalog } from "./types.ts";

export class ManifestError extends Error {
  readonly modelId: string | null;
  readonly path: string;

  constructor(message: string, opts: { modelId?: string | null; path: string }) {
    const id = opts.modelId ?? null;
    const prefix = id ? `model ${id}: ` : "";
    super(`${prefix}${opts.path}: ${message}`);
    this.name = "ManifestError";
    this.modelId = id;
    this.path = opts.path;
  }
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function fail(path: string, message: string, modelId?: string | null): never {
  throw new ManifestError(message, { path, modelId });
}

export function expectString(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  modelId?: string | null,
): string {
  const v = obj[key];
  if (typeof v !== "string" || v.trim() === "") {
    fail(`${path}.${key}`, "必须是非空字符串", modelId);
  }
  return v;
}

export function expectBoolean(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  modelId?: string | null,
): boolean {
  const v = obj[key];
  if (typeof v !== "boolean") {
    fail(`${path}.${key}`, "必须是 boolean", modelId);
  }
  return v;
}

export function expectFiniteNumber(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  modelId?: string | null,
  opts?: { positive?: boolean; min?: number; max?: number },
): number {
  const v = obj[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    fail(`${path}.${key}`, "必须是有限数字", modelId);
  }
  if (opts?.positive && !(v > 0)) {
    fail(`${path}.${key}`, "必须是正数", modelId);
  }
  if (opts?.min !== undefined && v < opts.min) {
    fail(`${path}.${key}`, `必须 ≥ ${opts.min}`, modelId);
  }
  if (opts?.max !== undefined && v > opts.max) {
    fail(`${path}.${key}`, `必须 ≤ ${opts.max}`, modelId);
  }
  return v;
}

/** 固定同源 base：用 URL 解析拦截反斜杠/外部 origin，只允许规范的站点逻辑路径 */
const STATIC_ASSET_BASE = "https://assets.invalid";

/** 本站静态资产 URL：仅接受规范的站点逻辑路径，拒绝外部、query/hash、反斜杠、穿越 */
function expectStaticUrl(
  url: unknown,
  path: string,
  modelId: string,
): string {
  if (typeof url !== "string" || url.trim() === "") {
    fail(path, "必须是非空字符串", modelId);
  }
  if (url.includes("\\")) {
    fail(path, "禁止反斜杠路径（可被解析为跨域）", modelId);
  }
  if (url.includes("?") || url.includes("#")) {
    fail(path, "禁止 query 或 hash", modelId);
  }
  if (/^https?:\/\//i.test(url) || url.startsWith("//")) {
    fail(path, "禁止外部 URL，须为本站静态路径", modelId);
  }
  if (!url.startsWith("/")) {
    fail(path, "须以 / 开头的本站路径", modelId);
  }
  let decoded: string;
  try { decoded = decodeURIComponent(url); } catch { fail(path, "非法 URL 编码", modelId); }
  if (decoded.includes("\\") || decoded.split("/").some((part, i) => i > 0 && (part === "" || part === "." || part === ".."))) {
    fail(path, "禁止穿越、反斜杠与空路径段", modelId);
  }
  let parsed: URL;
  try {
    parsed = new URL(url, STATIC_ASSET_BASE);
  } catch {
    fail(path, "不是合法 URL", modelId);
  }
  if (parsed.origin !== STATIC_ASSET_BASE) {
    fail(path, "禁止外部 URL，须为本站静态路径", modelId);
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    fail(path, "禁止 query 或 hash", modelId);
  }
  const pathname = parsed.pathname;
  const rest = pathname.slice(1);
  if (
    !rest ||
    rest.split("/").some((s) => s === "" || s === "." || s === "..")
  ) {
    fail(path, "须为本站规范文件路径（禁止穿越与空段）", modelId);
  }
  return pathname;
}

export function parseAssetFile(
  raw: unknown,
  path: string,
  modelId: string,
): AssetFile {
  if (!isPlainObject(raw)) {
    fail(path, "必须是 { url, sizeBytes } 对象", modelId);
  }
  const url = expectStaticUrl(raw.url, `${path}.url`, modelId);
  const sizeBytes = expectFiniteNumber(raw, "sizeBytes", path, modelId, {
    positive: true,
  });
  if (!Number.isSafeInteger(sizeBytes)) {
    fail(`${path}.sizeBytes`, "必须是正整数", modelId);
  }
  const sha256 = raw.sha256;
  if (sha256 !== undefined && (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256))) {
    fail(`${path}.sha256`, "必须是 64 位小写十六进制 SHA-256", modelId);
  }
  return { url, sizeBytes, ...(sha256 === undefined ? {} : { sha256 }) };
}

/** 解析并完整校验 catalog；任何结构/参数错误在此抛出（早于资产下载） */
export function parseCatalog<T extends AssetModelEntry>(
  raw: unknown,
  parseEntry: (raw: Record<string, unknown>, index: number) => T,
): ValidatedModelCatalog<T> {
  if (!isPlainObject(raw)) {
    fail("", "根节点必须是对象");
  }
  if (!Array.isArray(raw.models)) {
    fail("models", "必须是非空数组");
  }
  if (raw.models.length === 0) {
    fail("models", "不能为空");
  }

  const models: T[] = [];
  const ids = new Set<string>();
  const recommendedByPipeline = new Map<string, number>();

  for (let i = 0; i < raw.models.length; i++) {
    const item = raw.models[i];
    if (!isPlainObject(item)) {
      fail(`models[${i}]`, "必须是对象");
    }
    const entry = parseEntry(item, i);
    if (ids.has(entry.id)) {
      fail(`models[${i}].id`, `重复的模型 id "${entry.id}"`, entry.id);
    }
    ids.add(entry.id);
    if (entry.recommended) {
      recommendedByPipeline.set(
        entry.pipeline,
        (recommendedByPipeline.get(entry.pipeline) ?? 0) + 1,
      );
    }
    models.push(entry);
  }

  const presentPipelines = new Set(models.map((m) => m.pipeline));
  for (const pipeline of presentPipelines) {
    const n = recommendedByPipeline.get(pipeline) ?? 0;
    if (n !== 1) {
      fail(
        "models",
        `pipeline "${pipeline}" 必须恰好有一个 recommended: true（当前 ${n} 个）`,
      );
    }
  }

  return { models };
}

export function toModelSummary(entry: AssetModelEntry): ModelSummary {
  const downloadBytes = Object.values(entry.files).reduce(
    (sum, file) => sum + file.sizeBytes,
    0,
  );
  return {
    id: entry.id,
    name: entry.name,
    label: entry.label,
    recommended: entry.recommended,
    downloadBytes,
  };
}

/** 整份 catalog 的有效 Cache API 键集合（url?rev=revision） */
export function catalogCacheKeys(catalog: ValidatedModelCatalog): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const m of catalog.models) {
    for (const file of Object.values(m.files)) {
      keys.add(assetCacheKey(file.url, m.revision));
    }
  }
  return keys;
}

export function assetCacheKey(url: string, revision: string): string {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}rev=${encodeURIComponent(revision)}`;
}

/** URL 和解析器由调用者提供；不读取宿主框架环境变量。 */
export async function loadCatalog<T>(url: string, parse: (raw: unknown) => T, signal?: AbortSignal): Promise<T> {
  const resp = await fetch(url, { signal });
  if (!resp.ok) throw new ManifestError(`HTTP ${resp.status}`, { path: url });
  let raw: unknown;
  try { raw = await resp.json(); }
  catch (error) {
    if (signal?.aborted) throw signal.reason;
    throw new ManifestError("响应不是合法 JSON", { path: url });
  }
  return parse(raw);
}
