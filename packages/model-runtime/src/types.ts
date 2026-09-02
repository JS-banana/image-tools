// 共享类型：校验后的模型清单联合、资产描述与通用加载进度

export interface AssetFile {
  url: string;
  sizeBytes: number;
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

export interface PpocrFiles {
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

export type ModelEntry = PpocrModelEntry | Ben2RemoveBgModelEntry;

/** BEN2 去背景清单条目；1024 / ImageNet mean-std / pixel_values→alphas 由 pipeline 不变量拥有 */
export interface Ben2RemoveBgModelEntry {
  id: string;
  name: string;
  label: string;
  recommended: boolean;
  revision: string;
  pipeline: "ben2-background-removal";
  files: { model: AssetFile };
}

export function isPpocrModelEntry(entry: ModelEntry): entry is PpocrModelEntry {
  return entry.pipeline === "ppocr-dbnet-ctc";
}

export function isBen2RemoveBgModelEntry(
  entry: ModelEntry,
): entry is Ben2RemoveBgModelEntry {
  return entry.pipeline === "ben2-background-removal";
}

export interface ValidatedModelCatalog {
  models: ModelEntry[];
}

/** 向 UI 投影的摘要；downloadBytes 由 files.*.sizeBytes 求和派生 */
export interface ModelSummary {
  id: string;
  name: string;
  label: string;
  recommended: boolean;
  downloadBytes: number;
}

export interface ModelLoadProgress {
  /** 0–100；无法确定总大小时为 null（不定进度） */
  pct: number | null;
  label: string;
  fromCache: boolean;
  loadedBytes: number;
  totalBytes: number;
}
