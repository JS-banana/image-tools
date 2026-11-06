import { createAssetStore } from "@img/model-runtime";
import { RemoveBgRuntime, RuntimeClosedError, createBen2Pipeline, type RemoveBgBackend } from "@img/remove-bg/engine";
import { parseRemoveBgCatalog } from "@img/remove-bg/models";
import type { EngineDeployment } from "../lib/worker-protocol.ts";
import { emit, installWorker, type WorkerPixels } from "./host.ts";

let runtime: RemoveBgRuntime | null = null;
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
    if (runtime) throw new Error("去背景引擎已经初始化");
    const payload = request.payload as {
      catalog: unknown; modelId: string; backend: RemoveBgBackend; deployment: EngineDeployment;
    };
    const catalog = parseRemoveBgCatalog(payload.catalog);
    const entry = catalog.models.find((model) => model.id === payload.modelId);
    if (!entry) throw new Error(`未知去背景模型: ${payload.modelId}`);
    const store = createAssetStore({
      namespace: "image-tools-remove-bg-v1", legacyNamespace: "ocr-models-v1", baseURL: payload.deployment.assetBaseURL,
    });
    const keys = new Set(catalog.models.flatMap((model) =>
      Object.values(model.files).map((file) => store.cacheKey(file.url, model.revision)),
    ));
    void store.prune(keys);
    runtime = new RemoveBgRuntime({
      entry,
      backend: payload.backend,
      loadAssets: store.loadAssets,
      createPipeline: (model, bytes, backend) => createBen2Pipeline(model, bytes, backend, { wasmBaseURL: payload.deployment.wasmBaseURL }),
    });
    return {};
  }
  if (!runtime) throw new Error("去背景引擎尚未初始化");
  if (request.method === "load") {
    await runtime.load((progress) => emit(request.id, "load-progress", progress));
    return {};
  }
  if (request.method === "run") {
    const value = await runtime.run(request.payload as WorkerPixels);
    return { value, transfer: [value.alpha.buffer] };
  }
  throw new Error(`去背景不支持操作 ${request.method}`);
});
