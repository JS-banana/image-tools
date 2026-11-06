"use client";

import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
import type { ModelLoadProgress, ModelSummary } from "@img/model-runtime";
import {
  BackendUnavailableError,
  compose,
  RuntimeClosedError,
  StaleRunError,
  type RemoveBgBackend,
} from "@img/remove-bg";
import { createRemoveBgClient, loadRemoveBgModel } from "@/lib/tool-engines";
import { decodeImageFile } from "@/shared/browser-image/decode";
import { useImageInput, type ImageOrigin } from "@/shared/browser-image/use-image-input";
import { TaskScope, type TaskTicket } from "@/shared/task-scope";
import { REMOVE_BG_IMAGE_POLICY } from "./image-policy";
import {
  downloadBasename,
  readableError,
  toBackground,
  type BgChoice,
  type RunMeta,
  type UiStatus,
  type ViewMode,
} from "./presentation";

type RemoveBgClient = ReturnType<typeof createRemoveBgClient>;
interface SourceImage {
  image: ImageData;
  name: string | null;
  scaled: boolean;
}

type GpuNavigator = Navigator & {
  gpu?: { requestAdapter?: () => Promise<unknown> };
};

async function probeWebGpu(): Promise<boolean> {
  const gpu = (navigator as GpuNavigator).gpu;
  if (!gpu || typeof gpu.requestAdapter !== "function") return false;
  try {
    return (await gpu.requestAdapter()) != null;
  } catch {
    return false;
  }
}

function shouldIgnore(error: unknown): boolean {
  return error instanceof StaleRunError || error instanceof RuntimeClosedError;
}

export function useRemoveBgController() {
  const [source, setSource] = useState<SourceImage | null>(null);
  const [alpha, setAlpha] = useState<Uint8ClampedArray | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const [status, setStatus] = useState<UiStatus>({ kind: "idle" });
  const [runMeta, setRunMeta] = useState<RunMeta | null>(null);
  const [activeBackend, setActiveBackend] = useState<RemoveBgBackend | null>(null);
  const [bgChoice, setBgChoice] = useState<BgChoice>("transparent");
  const [customHex, setCustomHex] = useState("#ffffff");
  const [view, setView] = useState<ViewMode>("effect");
  const [holding, setHolding] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const lifecycle = useRef(new TaskScope());
  const imageTasks = useRef(new TaskScope());
  const decodeTasks = useRef(new TaskScope());
  const bootTasks = useRef(new TaskScope());
  const runTasks = useRef(new TaskScope());
  const modelRef = useRef<ModelSummary | null>(null);
  const runtimeRef = useRef<RemoveBgClient | null>(null);
  const runtimeDisposeRef = useRef<Promise<void>>(Promise.resolve());
  const backendRef = useRef<RemoveBgBackend | null>(null);
  const sourceRef = useRef<SourceImage | null>(null);
  const matteRef = useRef<Uint8ClampedArray | null>(null);
  const downloadUrlRef = useRef<string | null>(null);
  const statusRef = useRef<UiStatus>({ kind: "idle" });

  // Async continuations use the same status as event handlers in this tick.
  const updateStatus = useCallback((next: UiStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  const revokeDownloadUrl = useCallback(() => {
    if (downloadUrlRef.current) {
      URL.revokeObjectURL(downloadUrlRef.current);
      downloadUrlRef.current = null;
    }
  }, []);

  const enqueueRuntimeDispose = useCallback((runtime: RemoveBgClient | null) => {
    const next = runtimeDisposeRef.current
      .catch((error) => console.warn("[remove-bg] 前一引擎释放失败:", readableError(error)))
      .then(async () => { await runtime?.dispose(); })
      .catch((error) => console.warn("[remove-bg] 引擎释放失败:", readableError(error)));
    runtimeDisposeRef.current = next;
    return next;
  }, []);

  const disposeRuntime = useCallback(() => {
    const runtime = runtimeRef.current;
    runtimeRef.current = null;
    backendRef.current = null;
    setActiveBackend(null);
    return enqueueRuntimeDispose(runtime);
  }, [enqueueRuntimeDispose]);

  const reportProgress = useCallback((progress: ModelLoadProgress) => {
    const label =
      progress.pct !== null && progress.pct >= 100
        ? "初始化推理引擎…"
        : progress.fromCache
          ? "读取本机缓存…"
          : progress.pct === null
            ? "下载模型…"
            : `下载模型 ${Math.round(progress.pct)}%`;
    updateStatus({ kind: "loading", ...progress, label });
  }, [updateStatus]);

  const runCurrent = useCallback(async (imageTicket: TaskTicket) => {
    const runtime = runtimeRef.current;
    const currentSource = sourceRef.current;
    if (!runtime || !currentSource || !imageTicket.isCurrent()) return;
    const runTicket = runTasks.current.next();
    const isCurrent = () => imageTicket.isCurrent() && runTicket.isCurrent() && runtimeRef.current === runtime;
    updateStatus({ kind: "running" });
    setAlpha(null);
    matteRef.current = null;
    setDownloadError(null);
    try {
      const output = await runtime.run(currentSource.image);
      if (!isCurrent()) return;
      matteRef.current = output.alpha;
      setAlpha(output.alpha);
      setRunMeta({ backend: output.backend, totalMs: output.totalMs });
      updateStatus({ kind: "ok" });
    } catch (error) {
      if (shouldIgnore(error) || !isCurrent()) return;
      updateStatus({ kind: "error", message: readableError(error), action: "run" });
    }
  }, [updateStatus]);

  const loadAndRun = useCallback(async () => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    const imageTicket = imageTasks.current.capture();
    const isCurrent = () => imageTicket.isCurrent() && runtimeRef.current === runtime;
    try {
      await runtime.load((progress) => {
        if (isCurrent()) reportProgress(progress);
      });
      if (!isCurrent()) return;
      if (!sourceRef.current) {
        updateStatus({ kind: "ok" });
        return;
      }
      await runCurrent(imageTicket);
    } catch (error) {
      if (shouldIgnore(error) || !isCurrent()) return;
      if (backendRef.current === "webgpu" && error instanceof BackendUnavailableError) {
        // Publish the fallback choice before disposal: a replacement image arriving
        // while the worker closes must not stay stuck in the loading state.
        updateStatus({ kind: "need-wasm", detail: error.message || "WebGPU 初始化失败。" });
        await disposeRuntime();
        return;
      }
      updateStatus({ kind: "error", message: readableError(error), action: "load" });
    }
  }, [disposeRuntime, reportProgress, runCurrent, updateStatus]);

  const createLoadAndRun = useCallback(async (
    model: ModelSummary,
    backend: RemoveBgBackend,
    bootTicket: TaskTicket,
  ) => {
    if (!bootTicket.isCurrent()) return;
    updateStatus({ kind: "loading", label: "初始化推理引擎…", pct: null, loadedBytes: 0, totalBytes: 0 });
    await disposeRuntime();
    if (!bootTicket.isCurrent()) return;
    runtimeRef.current = createRemoveBgClient({ modelId: model.id, backend });
    backendRef.current = backend;
    setActiveBackend(backend);
    await loadAndRun();
  }, [disposeRuntime, loadAndRun, updateStatus]);

  const prepare = useCallback(async (backend?: RemoveBgBackend) => {
    const bootTicket = bootTasks.current.next();
    try {
      updateStatus({ kind: "loading", label: "正在读取模型配置…", pct: null, loadedBytes: 0, totalBytes: 0 });
      let model = modelRef.current;
      if (!model) {
        model = await loadRemoveBgModel();
        if (!bootTicket.isCurrent()) return;
        modelRef.current = model;
      }
      let chosen = backend;
      if (!chosen) {
        const gpuOk = await probeWebGpu();
        if (!bootTicket.isCurrent()) return;
        if (!gpuOk) {
          updateStatus({ kind: "need-wasm", detail: "当前浏览器没有可用的 WebGPU。" });
          return;
        }
        chosen = "webgpu";
      }
      await createLoadAndRun(model, chosen, bootTicket);
    } catch (error) {
      if (shouldIgnore(error) || !bootTicket.isCurrent()) return;
      updateStatus({ kind: "error", message: readableError(error), action: "prepare" });
    }
  }, [createLoadAndRun, updateStatus]);

  const afterImageReady = useCallback(() => {
    if (runtimeRef.current) {
      void loadAndRun();
    } else if (statusRef.current.kind !== "need-wasm" && statusRef.current.kind !== "loading") {
      void prepare();
    }
  }, [loadAndRun, prepare]);

  const loadImageFile = useCallback((file: File | undefined | null, origin: ImageOrigin) => {
    if (!file) return;
    const decodeTicket = decodeTasks.current.next();
    void (async () => {
      try {
        const decoded = await decodeImageFile(file, REMOVE_BG_IMAGE_POLICY);
        if (!decodeTicket.isCurrent()) return;
        imageTasks.current.invalidate();
        runTasks.current.invalidate();
        const nextSource: SourceImage = {
          image: decoded.imageData,
          name: origin === "paste" ? null : file.name,
          scaled: decoded.scaled,
        };
        sourceRef.current = nextSource;
        matteRef.current = null;
        revokeDownloadUrl();
        setSource(nextSource);
        setAlpha(null);
        setRunMeta(null);
        setDownloadError(null);
        setImageError(null);
        setView("effect");
        setHolding(false);
        afterImageReady();
      } catch (error) {
        if (decodeTicket.isCurrent()) setImageError(readableError(error));
      }
    })();
  }, [afterImageReady, revokeDownloadUrl]);

  const input = useImageInput(loadImageFile);
  const { resetInput } = input;
  const hasImage = source !== null;
  const hasResult = alpha !== null;

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.removeBg = hasImage ? "working" : "idle";
    return () => { delete root.dataset.removeBg; };
  }, [hasImage]);

  useEffect(() => {
    const scopes = [lifecycle.current, imageTasks.current, decodeTasks.current, bootTasks.current, runTasks.current];
    return () => {
      for (const scope of scopes) scope.invalidate();
      const runtime = runtimeRef.current;
      runtimeRef.current = null;
      backendRef.current = null;
      sourceRef.current = null;
      matteRef.current = null;
      void enqueueRuntimeDispose(runtime);
      revokeDownloadUrl();
    };
  }, [enqueueRuntimeDispose, revokeDownloadUrl]);

  const clearImage = useCallback(() => {
    decodeTasks.current.invalidate();
    imageTasks.current.invalidate();
    bootTasks.current.invalidate();
    runTasks.current.invalidate();
    sourceRef.current = null;
    matteRef.current = null;
    revokeDownloadUrl();
    setSource(null);
    setAlpha(null);
    setRunMeta(null);
    setImageError(null);
    setDownloadError(null);
    setHolding(false);
    setView("effect");
    updateStatus({ kind: "idle" });
    void disposeRuntime();
    resetInput();
  }, [disposeRuntime, resetInput, revokeDownloadUrl, updateStatus]);

  const confirmWasm = useCallback(() => {
    // prepare reuses cached metadata and serializes disposal before a new worker.
    void prepare("wasm");
  }, [prepare]);

  const retry = useCallback(() => {
    const current = statusRef.current;
    if (current.kind !== "error") return;
    if (current.action === "prepare" || !runtimeRef.current) {
      void prepare();
    } else {
      // load() reuses a healthy session and restores one after a worker crash.
      void loadAndRun();
    }
  }, [loadAndRun, prepare]);

  const downloadPng = useCallback(async () => {
    const currentSource = sourceRef.current;
    const matte = matteRef.current;
    if (!currentSource || !matte) return;
    const imageTicket = imageTasks.current.capture();
    const lifeTicket = lifecycle.current.capture();
    const isCurrent = () => imageTicket.isCurrent() && lifeTicket.isCurrent();
    setDownloadError(null);
    const exportCanvas = document.createElement("canvas");
    try {
      const { image, name } = currentSource;
      const pixels = compose(image, matte, toBackground(bgChoice, customHex));
      exportCanvas.width = image.width;
      exportCanvas.height = image.height;
      const context = exportCanvas.getContext("2d");
      if (!context) throw new Error("无法导出 PNG，请重试");
      context.putImageData(new ImageData(pixels, image.width, image.height), 0, 0);
      const blob = await new Promise<Blob | null>((resolve) => exportCanvas.toBlob(resolve, "image/png"));
      if (!isCurrent()) return;
      if (!blob) throw new Error("无法导出 PNG，请重试");
      revokeDownloadUrl();
      const url = URL.createObjectURL(blob);
      downloadUrlRef.current = url;
      const link = document.createElement("a");
      link.href = url;
      link.download = `${downloadBasename(name)}-remove-bg.png`;
      link.click();
      window.setTimeout(() => {
        if (downloadUrlRef.current === url) revokeDownloadUrl();
      }, 1000);
    } catch (error) {
      if (isCurrent()) setDownloadError(readableError(error));
    } finally {
      exportCanvas.width = 0;
      exportCanvas.height = 0;
    }
  }, [bgChoice, customHex, revokeDownloadUrl]);

  const onHoldPointerDown = (event: PointerEvent<HTMLElement>) => {
    if (!hasResult) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setHolding(true);
  };
  const onHoldPointerUp = () => setHolding(false);

  return {
    ...input,
    image: source?.image ?? null,
    alpha,
    hasImage,
    hasResult,
    imageError,
    imageSize: source ? { w: source.image.width, h: source.image.height } : null,
    scaledNote: source?.scaled
      ? `图片最长边超过 ${REMOVE_BG_IMAGE_POLICY.maxOutputSide} 像素，已等比缩小到 ${source.image.width}×${source.image.height}`
      : null,
    status,
    runMeta,
    bgChoice,
    setBgChoice,
    customHex,
    setCustomHex,
    view,
    setView,
    showSource: view === "source" || holding,
    busy: status.kind === "loading" || status.kind === "running",
    displayBackend: runMeta?.backend ?? activeBackend,
    downloadError,
    loadImageFile,
    clearImage,
    confirmWasm,
    retry,
    downloadPng,
    onHoldPointerDown,
    onHoldPointerUp,
  };
}
