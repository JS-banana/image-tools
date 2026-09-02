// 去背景领域类型、模型不变量与错误。不含 onnxruntime-web。

export const BEN2_INPUT_SIZE = 1024;
export const BEN2_INPUT_NAME = "pixel_values";
export const BEN2_OUTPUT_NAME = "alphas";
export const BEN2_INPUT_SHAPE = [1, 3, BEN2_INPUT_SIZE, BEN2_INPUT_SIZE] as const;
export const BEN2_OUTPUT_SHAPE = [1, 1, BEN2_INPUT_SIZE, BEN2_INPUT_SIZE] as const;
export const IMAGENET_MEAN = [0.485, 0.456, 0.406] as const;
export const IMAGENET_STD = [0.229, 0.224, 0.225] as const;
export const ALPHA_RANGE_EPS = 1e-6;

export type RemoveBgBackend = "webgpu" | "wasm";

/** Node 可构造；不依赖浏览器 ImageData。data 为 RGBA 紧凑缓冲。 */
export interface ImageDataLike {
  readonly data: ArrayLike<number>;
  readonly width: number;
  readonly height: number;
}

export type SolidColor = readonly [r: number, g: number, b: number];
export type ComposeBackground = "transparent" | SolidColor;

export interface RemoveBgRunResult {
  alpha: Uint8ClampedArray<ArrayBuffer>;
  width: number;
  height: number;
  backend: RemoveBgBackend;
  preprocessMs: number;
  inferenceMs: number;
  postprocessMs: number;
  totalMs: number;
}

export interface RemoveBgPipeline {
  readonly backend: RemoveBgBackend;
  run(image: ImageDataLike): Promise<RemoveBgRunResult>;
  dispose(): Promise<void>;
}

export class RemoveBgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoveBgError";
  }
}

export class InvalidImageError extends RemoveBgError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidImageError";
  }
}

export class InvalidAlphaError extends RemoveBgError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAlphaError";
  }
}

export class InvalidComposeError extends RemoveBgError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidComposeError";
  }
}

export class SessionContractError extends RemoveBgError {
  constructor(message: string) {
    super(message);
    this.name = "SessionContractError";
  }
}

export class BackendUnavailableError extends RemoveBgError {
  readonly backend: RemoveBgBackend;
  constructor(backend: RemoveBgBackend, cause?: unknown) {
    const detail = cause instanceof Error ? cause.message : cause != null ? String(cause) : "";
    super(detail ? `后端 ${backend} 不可用: ${detail}` : `后端 ${backend} 不可用`);
    this.name = "BackendUnavailableError";
    this.backend = backend;
  }
}

export class RuntimeClosedError extends RemoveBgError {
  constructor() {
    super("Runtime 已关闭");
    this.name = "RuntimeClosedError";
  }
}

export class RuntimeNotReadyError extends RemoveBgError {
  constructor(phase: string) {
    super(`模型未就绪（${phase}）`);
    this.name = "RuntimeNotReadyError";
  }
}

export class StaleRunError extends RemoveBgError {
  constructor() {
    super("本次推理已被更新的请求取代");
    this.name = "StaleRunError";
  }
}

export class PipelineDisposedError extends RemoveBgError {
  constructor() {
    super("Pipeline 已 dispose");
    this.name = "PipelineDisposedError";
  }
}

export function isRemoveBgBackend(value: unknown): value is RemoveBgBackend {
  return value === "webgpu" || value === "wasm";
}

export function assertImageData(image: ImageDataLike): ImageDataLike {
  if (image == null || typeof image !== "object") {
    throw new InvalidImageError("图像必须是 ImageData-like 对象");
  }
  const width = image.width;
  const height = image.height;
  if (
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new InvalidImageError(`非法图像尺寸: ${String(width)}x${String(height)}`);
  }
  const data = image.data;
  if (data == null || typeof data.length !== "number") {
    throw new InvalidImageError("缺少像素缓冲");
  }
  const expected = width * height * 4;
  if (data.length !== expected) {
    throw new InvalidImageError(
      `像素缓冲长度 ${data.length} 与尺寸 ${width}x${height} 不匹配（需要 ${expected}）`,
    );
  }
  return image;
}
