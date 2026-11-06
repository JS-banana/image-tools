// This is a bundler entry owned by the Next host. The reusable engine has no Next dependency.
import { createAssetStore } from "@img/model-runtime";
import { OcrRuntime, RuntimeClosedError, createPpocrPipeline, supportsOcrCanvas } from "@img/ocr/engine";
import { parseOcrCatalog } from "@img/ocr/models";
import type { EngineDeployment } from "../lib/worker-protocol.ts";
import { emit, installWorker, type WorkerPixels } from "./host.ts";

let runtime: OcrRuntime | null = null;
let closed = false;

installWorker(async (request) => {
  if (request.method === "dispose") {
    closed = true;
    await runtime?.dispose();
    runtime = null;
    return {};
  }
  if (closed) throw new RuntimeClosedError();
  if (request.method === "init") {
    if (runtime) throw new Error("OCR 引擎已经初始化");
    if (!supportsOcrCanvas()) throw new Error("当前浏览器不支持后台图片处理，请更新浏览器后重试");
    const payload = request.payload as { catalog: unknown; deployment: EngineDeployment };
    const catalog = parseOcrCatalog(payload.catalog);
    const store = createAssetStore({
      namespace: "image-tools-ocr-v1", legacyNamespace: "ocr-models-v1", baseURL: payload.deployment.assetBaseURL,
    });
    const keys = new Set(catalog.models.flatMap((model) =>
      Object.values(model.files).map((file) => store.cacheKey(file.url, model.revision)),
    ));
    void store.prune(keys);
    runtime = new OcrRuntime({
      catalog,
      loadAssets: store.loadAssets,
      createPipeline: (entry, files) => createPpocrPipeline(entry, files, { wasmBaseURL: payload.deployment.wasmBaseURL }),
      onState: (id, state) => emit(0, "state", { id, state }),
      onLoadProgress: (id, progress) => emit(0, "load-progress", { id, progress }),
    });
    return {};
  }
  if (!runtime) throw new Error("OCR 引擎尚未初始化");
  if (request.method === "select") {
    await runtime.select((request.payload as { id: string }).id);
    return {};
  }
  if (request.method === "run") {
    const image = request.payload as WorkerPixels;
    const value = await runtime.run(new ImageData(image.data, image.width, image.height),
      (progress) => emit(request.id, "run-progress", progress));
    return { value };
  }
  throw new Error(`OCR 不支持操作 ${request.method}`);
});
