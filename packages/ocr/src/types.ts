// OCR 领域类型：结果、进度回调与 Pipeline 接口（随 runtime 迁入 @img/ocr）

export interface OcrBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface OcrLine {
  box: OcrBox;
  text: string;
  confidence: number;
}

export interface OcrRunResult {
  results: OcrLine[];
  boxesFound: number;
  detMs: number;
  recMs: number;
  totalMs: number;
  backend: string;
}

export type ProgressFn = (p: { pct: number; label: string }) => void;

/** 公共 Pipeline 接口：无 dictSize（PP-OCR 内容不变量仅在 factory 内校验） */
export interface OcrPipeline {
  readonly backend: string;
  run(image: ImageData, onProgress?: ProgressFn): Promise<OcrRunResult>;
  dispose(): Promise<void>;
}
