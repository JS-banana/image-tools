/** A logical asset URL; deployment resolution belongs to the host. */
export interface AssetFile {
  url: string;
  sizeBytes: number;
  /** Optional content identity used when promoting bytes from a legacy cache. */
  sha256?: string;
}

/** Structural metadata only: this package has no knowledge of model pipelines. */
export interface AssetModelEntry {
  id: string;
  name: string;
  label: string;
  recommended: boolean;
  revision: string;
  pipeline: string;
  files: Readonly<Record<string, AssetFile>>;
}
export interface ValidatedModelCatalog<T extends AssetModelEntry = AssetModelEntry> { models: T[] }
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
