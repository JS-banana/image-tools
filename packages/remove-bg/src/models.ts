import {
  parseCatalog, loadCatalog, parseAssetFile as parseGenericAssetFile,
  isPlainObject, fail, expectString, expectBoolean,
  type AssetFile, type ValidatedModelCatalog,
} from "@img/model-runtime";

// Catalog paths remain logical /models paths; the host resolves deployment/CDN URLs.
function parseAssetFile(raw: unknown, path: string, modelId: string): AssetFile {
  const file = parseGenericAssetFile(raw, path, modelId);
  if (!file.url.startsWith("/models/")) fail(`${path}.url`, "须为 /models/ 下静态路径", modelId);
  return file;
}

export interface Ben2RemoveBgModelEntry {
  id: string;
  name: string;
  label: string;
  recommended: boolean;
  revision: string;
  pipeline: "ben2-background-removal";
  files: { model: AssetFile };
}


function parseBen2Files(
  raw: unknown,
  path: string,
  modelId: string,
): { model: AssetFile } {
  if (!isPlainObject(raw)) {
    fail(path, "必须是对象", modelId);
  }
  const keys = Object.keys(raw).sort();
  if (keys.length !== 1 || keys[0] !== "model") {
    fail(path, "必须恰好包含 model 一个键", modelId);
  }
  return { model: parseAssetFile(raw.model, `${path}.model`, modelId) };
}

function parseBen2RemoveBgEntry(
  raw: Record<string, unknown>,
  index: number,
): Ben2RemoveBgModelEntry {
  const path = `models[${index}]`;
  const id = expectString(raw, "id", path);
  const name = expectString(raw, "name", path, id);
  const label = expectString(raw, "label", path, id);
  const revision = expectString(raw, "revision", path, id);
  const recommended = expectBoolean(raw, "recommended", path, id);
  const pipeline = expectString(raw, "pipeline", path, id);
  if (pipeline !== "ben2-background-removal") {
    fail(
      `${path}.pipeline`,
      `未知 pipeline "${pipeline}"（当前仅支持 ben2-background-removal）`,
      id,
    );
  }
  const files = parseBen2Files(raw.files, `${path}.files`, id);
  return {
    id,
    name,
    label,
    recommended,
    revision,
    pipeline: "ben2-background-removal",
    files,
  };
}


export type RemoveBgModelCatalog = ValidatedModelCatalog<Ben2RemoveBgModelEntry>;
export function isBen2RemoveBgModelEntry(entry: { pipeline: string }): entry is Ben2RemoveBgModelEntry { return entry.pipeline === "ben2-background-removal"; }
export function parseRemoveBgCatalog(raw: unknown): RemoveBgModelCatalog { return parseCatalog(raw, parseBen2RemoveBgEntry); }
export function loadRemoveBgCatalog(url: string, signal?: AbortSignal): Promise<RemoveBgModelCatalog> { return loadCatalog(url, parseRemoveBgCatalog, signal); }
