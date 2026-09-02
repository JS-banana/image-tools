// 仅浏览器客户端（ssr:false 动态边界内）应导入本桶——pipeline 模块直接 import onnxruntime-web。
// 纯函数与 runtime 可按文件路径在 Node 中单独导入；runtime 默认 factory 才动态加载 pipeline。
export { preprocess } from "./preprocess.ts";
export { postprocess } from "./postprocess.ts";
export { compose } from "./compose.ts";
export { createBen2Pipeline } from "./pipeline.ts";
export { RemoveBgRuntime } from "./runtime.ts";
export type {
  CreatePipelineFn,
  LoadAssetsFn,
  RemoveBgRuntimeOptions,
} from "./runtime.ts";
export * from "./types.ts";
