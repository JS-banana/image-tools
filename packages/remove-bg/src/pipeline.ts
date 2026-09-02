// BEN2 流水线：本包唯一 onnxruntime-web 入口。后端显式指定，不做跨模式重试。

import * as ort from "onnxruntime-web";
import {
  isBen2RemoveBgModelEntry,
  withBasePath,
  type Ben2RemoveBgModelEntry,
} from "@img/model-runtime";
import { postprocess } from "./postprocess.ts";
import { preprocess } from "./preprocess.ts";
import {
  BEN2_INPUT_NAME,
  BEN2_INPUT_SHAPE,
  BEN2_OUTPUT_NAME,
  BEN2_OUTPUT_SHAPE,
  BackendUnavailableError,
  InvalidAlphaError,
  PipelineDisposedError,
  SessionContractError,
  type RemoveBgBackend,
  type RemoveBgPipeline,
  type RemoveBgRunResult,
} from "./types.ts";

function sameShape(
  actual: readonly (number | string)[],
  expected: readonly number[],
): boolean {
  if (actual.length !== expected.length) return false;
  for (let i = 0; i < expected.length; i++) {
    if (actual[i] !== expected[i]) return false;
  }
  return true;
}

function readStaticShape(
  metas: readonly ort.InferenceSession.ValueMetadata[],
  name: string,
): number[] {
  if (!Array.isArray(metas)) {
    throw new SessionContractError(`缺少 ${name} 的 session metadata`);
  }
  const meta = metas.find((m) => m.name === name);
  if (!meta) {
    throw new SessionContractError(`找不到 ${name} 的 metadata`);
  }
  if (!meta.isTensor) {
    throw new SessionContractError(`${name} 不是 tensor`);
  }
  const shape: number[] = [];
  for (const dim of meta.shape) {
    if (typeof dim !== "number" || !Number.isInteger(dim) || dim <= 0) {
      throw new SessionContractError(
        `${name} 含非静态维: ${JSON.stringify(meta.shape)}`,
      );
    }
    shape.push(dim);
  }
  return shape;
}

function assertSessionContract(session: ort.InferenceSession): void {
  if (session.inputNames.length !== 1 || session.inputNames[0] !== BEN2_INPUT_NAME) {
    throw new SessionContractError(
      `输入名必须唯一为 ${BEN2_INPUT_NAME}，实际 [${session.inputNames.join(", ")}]`,
    );
  }
  if (session.outputNames.length !== 1 || session.outputNames[0] !== BEN2_OUTPUT_NAME) {
    throw new SessionContractError(
      `输出名必须唯一为 ${BEN2_OUTPUT_NAME}，实际 [${session.outputNames.join(", ")}]`,
    );
  }
  const inputShape = readStaticShape(session.inputMetadata, BEN2_INPUT_NAME);
  if (!sameShape(inputShape, BEN2_INPUT_SHAPE)) {
    throw new SessionContractError(
      `输入 shape 必须是 [${BEN2_INPUT_SHAPE.join(", ")}]，实际 [${inputShape.join(", ")}]`,
    );
  }
  const outputShape = readStaticShape(session.outputMetadata, BEN2_OUTPUT_NAME);
  if (!sameShape(outputShape, BEN2_OUTPUT_SHAPE)) {
    throw new SessionContractError(
      `输出 shape 必须是 [${BEN2_OUTPUT_SHAPE.join(", ")}]，实际 [${outputShape.join(", ")}]`,
    );
  }
}

function asTensor(value: unknown, label: string): ort.Tensor {
  if (
    value == null ||
    typeof value !== "object" ||
    typeof (value as ort.Tensor).dispose !== "function" ||
    typeof (value as ort.Tensor).getData !== "function"
  ) {
    throw new SessionContractError(`${label} 不是 Tensor`);
  }
  return value as ort.Tensor;
}

function safeDisposeTensor(tensor: ort.Tensor | undefined): void {
  if (!tensor) return;
  try {
    tensor.dispose();
  } catch (e) {
    console.warn("[remove-bg] tensor dispose 失败:", (e as Error).message);
  }
}

export async function createBen2Pipeline(
  entry: Ben2RemoveBgModelEntry,
  model: ArrayBuffer,
  backend: RemoveBgBackend,
): Promise<RemoveBgPipeline> {
  if (!isBen2RemoveBgModelEntry(entry)) {
    throw new SessionContractError("entry 必须是 ben2-background-removal 清单条目");
  }
  if (!(model instanceof ArrayBuffer) || model.byteLength === 0) {
    throw new SessionContractError("模型字节必须是非空 ArrayBuffer");
  }

  ort.env.wasm.wasmPaths = withBasePath("/ort/");
  ort.env.wasm.numThreads = 1;

  let session: ort.InferenceSession;
  try {
    session = await ort.InferenceSession.create(new Uint8Array(model), {
      executionProviders: [backend],
    });
  } catch (e) {
    throw new BackendUnavailableError(backend, e);
  }

  try {
    assertSessionContract(session);
  } catch (e) {
    try {
      await session.release();
    } catch (releaseErr) {
      console.warn("[remove-bg] session release 失败:", (releaseErr as Error).message);
    }
    throw e;
  }

  let disposed = false;

  async function run(
    image: Parameters<RemoveBgPipeline["run"]>[0],
  ): Promise<RemoveBgRunResult> {
    if (disposed) throw new PipelineDisposedError();
    const t0 = performance.now();

    const tPre = performance.now();
    const chw = preprocess(image);
    const preprocessMs = performance.now() - tPre;

    let input: ort.Tensor | undefined;
    let output: ort.Tensor | undefined;
    let alpha: Uint8ClampedArray<ArrayBuffer>;
    let inferenceMs: number;
    let postprocessMs: number;
    try {
      const tInf = performance.now();
      input = new ort.Tensor("float32", chw, [...BEN2_INPUT_SHAPE]);
      const results = await session.run({ [BEN2_INPUT_NAME]: input });
      output = asTensor(results[BEN2_OUTPUT_NAME], BEN2_OUTPUT_NAME);
      if (!sameShape(output.dims, BEN2_OUTPUT_SHAPE)) {
        throw new SessionContractError(
          `推理输出 dims 必须是 [${BEN2_OUTPUT_SHAPE.join(", ")}]，实际 [${output.dims.join(", ")}]`,
        );
      }
      const raw = await output.getData();
      inferenceMs = performance.now() - tInf;
      if (!(raw instanceof Float32Array)) {
        throw new InvalidAlphaError(`输出 dtype 必须是 float32，实际 ${output.type}`);
      }
      const tPost = performance.now();
      alpha = postprocess(raw, image.width, image.height);
      postprocessMs = performance.now() - tPost;
    } finally {
      safeDisposeTensor(input);
      safeDisposeTensor(output);
    }

    return {
      alpha,
      width: image.width,
      height: image.height,
      backend,
      preprocessMs,
      inferenceMs,
      postprocessMs,
      totalMs: performance.now() - t0,
    };
  }

  async function dispose(): Promise<void> {
    if (disposed) return;
    disposed = true;
    try {
      await session.release();
    } catch (e) {
      console.warn("[remove-bg] session release 失败:", (e as Error).message);
    }
  }

  return { backend, run, dispose };
}
