// Main-thread facade: metadata and RPC only. ORT is imported inside each worker.
import { ManifestError, toModelSummary, type ModelLoadProgress, type ModelSummary } from "@img/model-runtime";
import {
  RuntimeBusyError,
  RuntimeClosedError as OcrClosedError,
  StaleSelectionError,
  type ModelState,
  type OcrRunResult,
  type ProgressFn,
} from "@img/ocr";
import { loadOcrCatalog } from "@img/ocr/models";
import {
  BackendUnavailableError,
  RuntimeClosedError as RemoveBgClosedError,
  RuntimeNotReadyError,
  StaleRunError,
  type RemoveBgBackend,
  type RemoveBgRunResult,
} from "@img/remove-bg";
import { loadRemoveBgCatalog } from "@img/remove-bg/models";
import { ToolWorkerClient } from "./worker-client.ts";
import { restoreError, type EngineDeployment } from "./worker-protocol.ts";

function deployment(): EngineDeployment {
  const basePath = (process.env.NEXT_PUBLIC_BASE_PATH ?? "").replace(/\/$/, "");
  const assetBaseURL = new URL(`${basePath}/`, window.location.origin).href;
  return { assetBaseURL, wasmBaseURL: new URL("ort/", assetBaseURL).href };
}

function pixelsForWorker(image: ImageData) {
  // The view retains its original pixels for preview/export. Transfer exactly one
  // owned copy instead of detaching the UI's buffer or cloning it a second time.
  const data = new Uint8ClampedArray(image.data);
  return { data, width: image.width, height: image.height };
}

export interface OcrClient {
  readonly models: ModelSummary[];
  selectedId(): string | null;
  state(id: string): ModelState;
  select(id: string): Promise<void>;
  run(image: ImageData, onProgress?: ProgressFn): Promise<OcrRunResult>;
  dispose(): Promise<void>;
}

interface OcrCallbacks {
  onState?: (id: string, state: ModelState) => void;
  onLoadProgress?: (id: string, progress: ModelLoadProgress) => void;
}

export async function createOcrClient(callbacks: OcrCallbacks = {}): Promise<OcrClient> {
  const config = deployment();
  const catalog = await loadOcrCatalog(new URL("catalogs/ocr.json", config.assetBaseURL).href);
  const states = new Map<string, ModelState>(catalog.models.map((model) => [model.id, {
    phase: "unloaded", backend: null, source: null, error: null,
  }]));
  let selected: string | null = null;
  let busy = false;
  let closed = false;
  const channel = new ToolWorkerClient({
    createWorker: () => new Worker(new URL("../workers/ocr.worker.ts", import.meta.url), { type: "module", name: "image-tools-ocr" }),
    init: { catalog, deployment: config },
    restoreError: (error) => restoreError(error, {
      RuntimeBusyError: RuntimeBusyError.prototype,
      RuntimeClosedError: OcrClosedError.prototype,
      StaleSelectionError: StaleSelectionError.prototype,
    }),
    onFailure(error) {
      if (closed) return;
      for (const id of states.keys()) {
        const state: ModelState = {
          phase: id === selected ? "failed" : "unloaded",
          backend: null, source: null,
          error: id === selected ? (error instanceof Error ? error.message : String(error)) : null,
        };
        states.set(id, state);
        callbacks.onState?.(id, { ...state });
      }
    },
    onEvent(event) {
      if (closed) return;
      if (event.name === "state") {
        const { id, state } = event.payload as { id: string; state: ModelState };
        states.set(id, state);
        callbacks.onState?.(id, { ...state });
      } else if (event.name === "load-progress") {
        const { id, progress } = event.payload as { id: string; progress: ModelLoadProgress };
        callbacks.onLoadProgress?.(id, progress);
      }
    },
  });
  return {
    models: catalog.models.map(toModelSummary),
    selectedId: () => selected,
    state(id) {
      const state = states.get(id);
      if (!state) throw new Error(`未知模型 id: ${id}`);
      return { ...state };
    },
    async select(id) {
      if (closed) throw new OcrClosedError();
      if (busy) throw new RuntimeBusyError();
      if (!states.has(id)) throw new Error(`未知模型 id: ${id}`);
      selected = id;
      try {
        await channel.call("select", { id });
      } catch (error) {
        if (!closed && selected === id && !(error instanceof StaleSelectionError) &&
          !(error instanceof Error && error.name === "AbortError")) {
          const state: ModelState = {
            phase: "failed", backend: null, source: null,
            error: error instanceof Error ? error.message : String(error),
          };
          states.set(id, state);
          callbacks.onState?.(id, { ...state });
        }
        throw error;
      }
    },
    async run(image, onProgress) {
      if (closed) throw new OcrClosedError();
      if (busy) throw new RuntimeBusyError();
      busy = true;
      try {
        const pixels = pixelsForWorker(image);
        return await channel.call<OcrRunResult>("run", pixels, [pixels.data.buffer], (event) => {
          if (event.name === "run-progress") onProgress?.(event.payload as Parameters<ProgressFn>[0]);
        });
      } finally {
        busy = false;
      }
    },
    dispose() {
      closed = true;
      return channel.dispose();
    },
  };
}

export interface RemoveBgClient {
  load(onProgress?: (progress: ModelLoadProgress) => void): Promise<void>;
  run(image: ImageData): Promise<RemoveBgRunResult>;
  dispose(): Promise<void>;
}

export async function loadRemoveBgModel(): Promise<ModelSummary> {
  const config = deployment();
  const catalog = await loadRemoveBgCatalog(new URL("catalogs/remove-bg.json", config.assetBaseURL).href);
  const model = catalog.models.find((entry) => entry.recommended);
  if (!model) throw new ManifestError("没有可用的推荐去背景模型", { path: "models" });
  return toModelSummary(model);
}

export function createRemoveBgClient(options: { modelId: string; backend: RemoveBgBackend }): RemoveBgClient {
  let closed = false;
  let channel: ToolWorkerClient | null = null;
  let opening: Promise<ToolWorkerClient> | null = null;
  let loading: Promise<void> | null = null;
  const loadSubscribers = new Set<(progress: ModelLoadProgress) => void>();
  const catalogAbort = new AbortController();
  const getChannel = (): Promise<ToolWorkerClient> => {
    if (closed) return Promise.reject(new RemoveBgClosedError());
    if (opening) return opening;
    opening = (async () => {
      const config = deployment();
      const catalog = await loadRemoveBgCatalog(
        new URL("catalogs/remove-bg.json", config.assetBaseURL).href,
        catalogAbort.signal,
      );
      if (closed) throw new RemoveBgClosedError();
      if (!catalog.models.some((entry) => entry.id === options.modelId)) {
        throw new ManifestError("当前部署不包含此去背景模型", { path: "models", modelId: options.modelId });
      }
      channel = new ToolWorkerClient({
        createWorker: () => new Worker(new URL("../workers/remove-bg.worker.ts", import.meta.url), { type: "module", name: "image-tools-remove-bg" }),
        init: { catalog, ...options, deployment: config },
        restoreError: (error) => restoreError(error, {
          BackendUnavailableError: BackendUnavailableError.prototype,
          RuntimeClosedError: RemoveBgClosedError.prototype,
          RuntimeNotReadyError: RuntimeNotReadyError.prototype,
          StaleRunError: StaleRunError.prototype,
        }),
      });
      return channel;
    })().catch((error) => {
      opening = null;
      throw error;
    });
    return opening;
  };
  return {
    async load(onProgress) {
      if (closed) throw new RemoveBgClosedError();
      if (onProgress) loadSubscribers.add(onProgress);
      try {
        // A replacement image joins the current download. Keep its progress
        // subscription even though the engine coalesces concurrent load calls.
        if (!loading) {
          loading = (async () => {
            const client = await getChannel();
            await client.call("load", undefined, [], (event) => {
              if (event.name === "load-progress" && !closed) {
                for (const subscriber of loadSubscribers) {
                  subscriber(event.payload as ModelLoadProgress);
                }
              }
            });
          })().finally(() => { loading = null; });
        }
        await loading;
      } finally {
        if (onProgress) loadSubscribers.delete(onProgress);
      }
    },
    async run(image) {
      if (closed) throw new RemoveBgClosedError();
      if (!channel) throw new RuntimeNotReadyError("unloaded");
      const pixels = pixelsForWorker(image);
      return channel.call<RemoveBgRunResult>("run", pixels, [pixels.data.buffer]);
    },
    dispose() {
      closed = true;
      loadSubscribers.clear();
      catalogAbort.abort();
      return channel?.dispose() ?? Promise.resolve();
    },
  };
}
