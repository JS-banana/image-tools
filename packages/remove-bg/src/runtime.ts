// RemoveBgRuntime：单模型生命周期。不导入 onnxruntime-web，不暴露 Session。

import {
  isBen2RemoveBgModelEntry,
  loadAssets as defaultLoadAssets,
  type AssetFile,
  type Ben2RemoveBgModelEntry,
  type ModelLoadProgress,
} from "@img/model-runtime";
import {
  RemoveBgError,
  RuntimeClosedError,
  RuntimeNotReadyError,
  StaleRunError,
  isRemoveBgBackend,
  type ImageDataLike,
  type RemoveBgBackend,
  type RemoveBgPipeline,
  type RemoveBgRunResult,
} from "./types.ts";

export type LoadAssetsFn = (
  files: Readonly<Record<string, AssetFile>>,
  revision: string,
  onProgress?: (progress: ModelLoadProgress) => void,
) => Promise<{
  files: Record<string, ArrayBuffer>;
  source: "cache" | "network" | "mixed";
}>;

export type CreatePipelineFn = (
  entry: Ben2RemoveBgModelEntry,
  model: ArrayBuffer,
  backend: RemoveBgBackend,
) => Promise<RemoveBgPipeline>;

export interface RemoveBgRuntimeOptions {
  entry: Ben2RemoveBgModelEntry;
  backend: RemoveBgBackend;
  loadAssets?: LoadAssetsFn;
  createPipeline?: CreatePipelineFn;
}

type Phase = "unloaded" | "loading" | "ready" | "failed";

function readableError(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

async function safeDispose(pipeline: RemoveBgPipeline): Promise<void> {
  try {
    await pipeline.dispose();
  } catch (e) {
    console.warn("[remove-bg] pipeline dispose 失败:", readableError(e));
  }
}

// Node 测试会直接导入 runtime；静态导入会在 Node 中提前求值浏览器专用 ORT 模块。
const defaultCreatePipeline: CreatePipelineFn = async (entry, model, backend) => {
  const { createBen2Pipeline } = await import("./pipeline.ts");
  return createBen2Pipeline(entry, model, backend);
};

export class RemoveBgRuntime {
  private readonly entry: Ben2RemoveBgModelEntry;
  private readonly backend: RemoveBgBackend;
  private readonly loadAssetsFn: LoadAssetsFn;
  private readonly createPipelineFn: CreatePipelineFn;

  private phase: Phase = "unloaded";
  private pipeline: RemoveBgPipeline | null = null;
  private loadInflight: Promise<void> | null = null;
  private runGeneration = 0;
  private runChain: Promise<void> = Promise.resolve();
  private closed = false;
  private disposePromise: Promise<void> | null = null;

  constructor(opts: RemoveBgRuntimeOptions) {
    if (!isBen2RemoveBgModelEntry(opts.entry)) {
      throw new RemoveBgError("entry 必须是 ben2-background-removal 清单条目");
    }
    if (!isRemoveBgBackend(opts.backend)) {
      throw new RemoveBgError("backend 必须是 webgpu 或 wasm");
    }
    this.entry = opts.entry;
    this.backend = opts.backend;
    this.loadAssetsFn = opts.loadAssets ?? defaultLoadAssets;
    this.createPipelineFn = opts.createPipeline ?? defaultCreatePipeline;
  }

  /**
   * 加载模型并创建 Pipeline。并发调用共享同一 Promise；失败后可再次 load 重试。
   */
  load(onProgress?: (progress: ModelLoadProgress) => void): Promise<void> {
    if (this.closed) return Promise.reject(new RuntimeClosedError());
    if (this.phase === "ready" && this.pipeline) return Promise.resolve();
    if (this.loadInflight) return this.loadInflight;

    const p = this.doLoad(onProgress);
    this.loadInflight = p;
    p.then(
      () => {
        if (this.loadInflight === p) this.loadInflight = null;
      },
      () => {
        if (this.loadInflight === p) this.loadInflight = null;
      },
    );
    return p;
  }

  /**
   * 串行推理。后发请求使仍在途或排队中的旧请求以 StaleRunError 结束。
   */
  run(image: ImageDataLike): Promise<RemoveBgRunResult> {
    if (this.closed) return Promise.reject(new RuntimeClosedError());
    if (this.phase !== "ready" || !this.pipeline) {
      return Promise.reject(new RuntimeNotReadyError(this.phase));
    }
    const gen = ++this.runGeneration;
    const pipeline = this.pipeline;
    const result = this.runChain.then(
      () => this.executeRun(gen, pipeline, image),
      () => this.executeRun(gen, pipeline, image),
    );
    this.runChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * 等待在途 load/run 收口后释放 Pipeline。重复调用安全；之后 load/run 不可复活。
   */
  dispose(): Promise<void> {
    if (!this.disposePromise) this.disposePromise = this.doDispose();
    return this.disposePromise;
  }

  private async executeRun(
    gen: number,
    pipeline: RemoveBgPipeline,
    image: ImageDataLike,
  ): Promise<RemoveBgRunResult> {
    if (this.closed) throw new RuntimeClosedError();
    if (gen !== this.runGeneration) throw new StaleRunError();
    if (this.pipeline !== pipeline) throw new RuntimeNotReadyError(this.phase);
    const out = await pipeline.run(image);
    if (this.closed) throw new RuntimeClosedError();
    if (gen !== this.runGeneration) throw new StaleRunError();
    return out;
  }

  private async doLoad(
    onProgress?: (progress: ModelLoadProgress) => void,
  ): Promise<void> {
    this.phase = "loading";
    let model: ArrayBuffer | undefined;
    try {
      const loaded = await this.loadAssetsFn(
        { model: this.entry.files.model },
        this.entry.revision,
        onProgress,
      );
      if (this.closed) throw new RuntimeClosedError();
      model = loaded.files.model;
      (loaded.files as Record<string, ArrayBuffer | undefined>).model = undefined;
      if (!(model instanceof ArrayBuffer) || model.byteLength === 0) {
        throw new RemoveBgError("loader 未返回 model 字节");
      }
      const pipeline = await this.createPipelineFn(this.entry, model, this.backend);
      model = undefined;
      this.pipeline = pipeline;
      if (this.closed) {
        this.pipeline = null;
        await safeDispose(pipeline);
        throw new RuntimeClosedError();
      }
      this.phase = "ready";
    } catch (e) {
      if (this.closed) {
        this.phase = "unloaded";
        throw e instanceof RuntimeClosedError ? e : new RuntimeClosedError();
      }
      this.phase = "failed";
      throw e;
    } finally {
      model = undefined;
    }
  }

  private async doDispose(): Promise<void> {
    this.closed = true;
    this.runGeneration++;
    await Promise.allSettled([this.loadInflight, this.runChain]);
    const pipeline = this.pipeline;
    this.pipeline = null;
    this.phase = "unloaded";
    if (pipeline) await safeDispose(pipeline);
  }
}
