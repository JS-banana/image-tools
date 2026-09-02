// 仅浏览器客户端（ssr:false 动态边界内）可导入本包——pipeline 模块直接 import onnxruntime-web。
export { createPpocrPipeline } from "./pipelines/ppocr-dbnet-ctc.ts";
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
  OcrBox,
  OcrLine,
  OcrPipeline,
  OcrRunResult,
  ProgressFn,
} from "./types.ts";
