// Lightweight public API: importing this entry does not evaluate ONNX Runtime.
export {
  OcrRuntime,
  RuntimeBusyError,
  RuntimeClosedError,
  StaleSelectionError,
} from "./runtime.ts";
export type {
  ModelPhase,
  ModelState,
  OcrRuntimeOptions,
} from "./runtime.ts";
export type {
  OcrEngineOptions,
  OcrBox,
  OcrLine,
  OcrPipeline,
  OcrRunResult,
  ProgressFn,
} from "./types.ts";
export { supportsOcrCanvas } from "./image-canvas.ts";
