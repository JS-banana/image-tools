import {
  parseCatalog, loadCatalog, parseAssetFile as parseGenericAssetFile,
  isPlainObject, fail, expectString, expectBoolean, expectFiniteNumber,
  type AssetFile, type ValidatedModelCatalog,
} from "@img/model-runtime";

// Catalog paths remain logical /models paths; the host resolves deployment/CDN URLs.
function parseAssetFile(raw: unknown, path: string, modelId: string): AssetFile {
  const file = parseGenericAssetFile(raw, path, modelId);
  if (!file.url.startsWith("/models/")) fail(`${path}.url`, "须为 /models/ 下静态路径", modelId);
  return file;
}

export interface PpocrParams {
  detMaxSide: number;
  recHeight: number;
  recMaxWidth: number;
  dictSize: number;
  colorOrder: "BGR";
  detThresh: number;
  boxThresh: number;
  unclipRatio: number;
  minBoxSide: number;
}

export type PpocrFiles = {
  det: AssetFile;
  rec: AssetFile;
  dict: AssetFile;
}

/** PP-OCR DBNet+CTC 清单条目 */
export interface PpocrModelEntry {
  id: string;
  name: string;
  label: string;
  recommended: boolean;
  revision: string;
  pipeline: "ppocr-dbnet-ctc";
  files: PpocrFiles;
  params: PpocrParams;
}


function parsePpocrFiles(
  raw: unknown,
  path: string,
  modelId: string,
): PpocrFiles {
  if (!isPlainObject(raw)) {
    fail(path, "必须是对象", modelId);
  }
  const keys = Object.keys(raw).sort();
  const expected = ["det", "dict", "rec"];
  if (keys.length !== 3 || keys.some((k, i) => k !== expected[i])) {
    fail(path, "必须恰好包含 det、rec、dict 三个键", modelId);
  }
  return {
    det: parseAssetFile(raw.det, `${path}.det`, modelId),
    rec: parseAssetFile(raw.rec, `${path}.rec`, modelId),
    dict: parseAssetFile(raw.dict, `${path}.dict`, modelId),
  };
}

function parsePpocrParams(
  raw: unknown,
  path: string,
  modelId: string,
): PpocrParams {
  if (!isPlainObject(raw)) {
    fail(path, "必须是对象", modelId);
  }
  const colorOrder = expectString(raw, "colorOrder", path, modelId);
  if (colorOrder !== "BGR") {
    fail(`${path}.colorOrder`, '当前仅允许 "BGR"', modelId);
  }
  const detMaxSide = expectFiniteNumber(raw, "detMaxSide", path, modelId, {
    positive: true,
  });
  if (!Number.isInteger(detMaxSide)) {
    fail(`${path}.detMaxSide`, "必须是正整数", modelId);
  }
  const recHeight = expectFiniteNumber(raw, "recHeight", path, modelId, {
    positive: true,
  });
  if (!Number.isInteger(recHeight)) {
    fail(`${path}.recHeight`, "必须是正整数", modelId);
  }
  const recMaxWidth = expectFiniteNumber(raw, "recMaxWidth", path, modelId, {
    positive: true,
  });
  if (!Number.isInteger(recMaxWidth)) {
    fail(`${path}.recMaxWidth`, "必须是正整数", modelId);
  }
  const dictSize = expectFiniteNumber(raw, "dictSize", path, modelId, {
    positive: true,
  });
  if (!Number.isInteger(dictSize) || dictSize < 3) {
    fail(`${path}.dictSize`, "必须是 ≥ 3 的整数（blank + chars + space）", modelId);
  }
  const detThresh = expectFiniteNumber(raw, "detThresh", path, modelId, {
    min: 0,
    max: 1,
  });
  const boxThresh = expectFiniteNumber(raw, "boxThresh", path, modelId, {
    min: 0,
    max: 1,
  });
  const unclipRatio = expectFiniteNumber(raw, "unclipRatio", path, modelId, {
    positive: true,
  });
  const minBoxSide = expectFiniteNumber(raw, "minBoxSide", path, modelId, {
    positive: true,
  });
  if (!Number.isInteger(minBoxSide)) {
    fail(`${path}.minBoxSide`, "必须是正整数", modelId);
  }
  if (recMaxWidth < recHeight) {
    fail(`${path}.recMaxWidth`, "必须 ≥ recHeight", modelId);
  }
  return {
    detMaxSide,
    recHeight,
    recMaxWidth,
    dictSize,
    colorOrder: "BGR",
    detThresh,
    boxThresh,
    unclipRatio,
    minBoxSide,
  };
}

function parsePpocrEntry(
  raw: Record<string, unknown>,
  index: number,
): PpocrModelEntry {
  const path = `models[${index}]`;
  const id = expectString(raw, "id", path);
  const name = expectString(raw, "name", path, id);
  const label = expectString(raw, "label", path, id);
  const revision = expectString(raw, "revision", path, id);
  const recommended = expectBoolean(raw, "recommended", path, id);
  const pipeline = expectString(raw, "pipeline", path, id);
  if (pipeline !== "ppocr-dbnet-ctc") {
    fail(
      `${path}.pipeline`,
      `未知 pipeline "${pipeline}"（当前仅支持 ppocr-dbnet-ctc）`,
      id,
    );
  }
  const files = parsePpocrFiles(raw.files, `${path}.files`, id);
  const params = parsePpocrParams(raw.params, `${path}.params`, id);
  return {
    id,
    name,
    label,
    recommended,
    revision,
    pipeline: "ppocr-dbnet-ctc",
    files,
    params,
  };
}


export type OcrModelCatalog = ValidatedModelCatalog<PpocrModelEntry>;
export function isPpocrModelEntry(entry: { pipeline: string }): entry is PpocrModelEntry { return entry.pipeline === "ppocr-dbnet-ctc"; }
export function parseOcrCatalog(raw: unknown): OcrModelCatalog { return parseCatalog(raw, parsePpocrEntry); }
export function loadOcrCatalog(url: string, signal?: AbortSignal): Promise<OcrModelCatalog> { return loadCatalog(url, parseOcrCatalog, signal); }
