// RemoveBgRuntime：单模型生命周期。不导入 onnxruntime-web，不暴露 Session。

import { createAssetStore, type AssetLoader, type ModelLoadProgress } from "@img/model-runtime";
import { isBen2RemoveBgModelEntry, type Ben2RemoveBgModelEntry } from "./models.ts";
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

export type LoadAssetsFn = AssetLoader;

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
  /** Required when using the default pipeline factory. */
  wasmBaseURL?: string;
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

export class RemoveBgRuntime {
  private readonly entry: Ben2RemoveBgModelEntry;
  private readonly backend: RemoveBgBackend;
  private readonly loadAssetsFn: LoadAssetsFn;
  private readonly createPipelineFn: CreatePipelineFn;

  private phase: Phase = "unloaded";
  private pipeline: RemoveBgPipeline | null = null;
  private loadInflight: Promise<void> | null = null;
  private loadController: AbortController | null = null;
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
    this.loadAssetsFn = opts.loadAssets ?? createAssetStore({ namespace: "image-tools-remove-bg-v1" }).loadAssets;
    this.createPipelineFn = opts.createPipeline ?? (async (entry, model, backend) => {
      if (!opts.wasmBaseURL) throw new RemoveBgError("使用默认 factory 时必须提供 wasmBaseURL");
      const { createBen2Pipeline } = await import("./pipeline.ts");
      return createBen2Pipeline(entry, model, backend, { wasmBaseURL: opts.wasmBaseURL });
    });
  }

  /**
   * 加载模型并创建 Pipeline。并发调用共享同一 Promise；失败后可再次 load 重试。
   */
  load(onProgress?: (progress: ModelLoadProgress) => void): Promise<void> {
    if (this.closed) return Promise.reject(new RuntimeClosedError());
    if (this.phase === "ready" && this.pipeline) return Promise.resolve();
    if (this.loadInflight) return this.loadInflight;

    const controller = new AbortController();
    this.loadController = controller;
    const p = this.doLoad(controller.signal, onProgress);
    this.loadInflight = p;
    p.then(
      () => {
        if (this.loadInflight === p) { this.loadInflight = null; this.loadController = null; }
      },
      () => {
        if (this.loadInflight === p) { this.loadInflight = null; this.loadController = null; }
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
    signal: AbortSignal,
    onProgress?: (progress: ModelLoadProgress) => void,
  ): Promise<void> {
    this.phase = "loading";
    let model: ArrayBuffer | undefined;
    try {
      const loaded = await this.loadAssetsFn(
        { model: this.entry.files.model },
        this.entry.revision,
        (progress) => { if (!signal.aborted && !this.closed) onProgress?.(progress); },
        signal,
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
    this.loadController?.abort(new RuntimeClosedError());
    await Promise.allSettled([this.loadInflight, this.runChain]);
    const pipeline = this.pipeline;
    this.pipeline = null;
    this.phase = "unloaded";
    if (pipeline) await safeDispose(pipeline);
  }
}
