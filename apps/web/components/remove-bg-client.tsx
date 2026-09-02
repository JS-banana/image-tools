"use client";

// 桌面产品界面：空态上传 → 单大预览 + 右侧控制。推理在浏览器本地完成；
// RemoveBgRuntime 持有唯一 Pipeline。本文件位于 ssr:false 动态边界内，才允许导入 ORT 桶。
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  catalogCacheKeys,
  isBen2RemoveBgModelEntry,
  loadModelCatalog,
  ManifestError,
  pruneAssetCache,
  type Ben2RemoveBgModelEntry,
  type ModelLoadProgress,
} from "@img/model-runtime";
import {
  BackendUnavailableError,
  compose,
  RemoveBgRuntime,
  RuntimeClosedError,
  StaleRunError,
  type ComposeBackground,
  type RemoveBgBackend,
} from "@img/remove-bg";
import { SiteHeader } from "@/components/site-header";
import { decodeImageFile, MAX_IMAGE_SIDE } from "@/lib/remove-bg-image";

const primaryBtn =
  "min-h-11 rounded-[8px] bg-accent px-4 py-2.5 text-[13px] font-medium text-[#171717] transition-[opacity,scale] duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-ink enabled:[@media(hover:hover)]:hover:opacity-90 enabled:active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40";
const secondaryBtn =
  "min-h-11 rounded-[8px] border border-border bg-panel px-4 py-2.5 text-[13px] font-medium text-text transition-[border-color,scale] duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-ink enabled:[@media(hover:hover)]:hover:border-accent/70 enabled:active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40";

type BgChoice = "transparent" | "white" | "black" | "custom";
type ViewMode = "effect" | "source";
type ErrorAction = "prepare" | "load" | "run";

type UiStatus =
  | { kind: "idle" }
  | {
      kind: "loading";
      label: string;
      pct: number | null;
      loadedBytes: number;
      totalBytes: number;
    }
  | { kind: "need-wasm"; detail: string }
  | { kind: "running" }
  | { kind: "ok" }
  | { kind: "error"; message: string; action: ErrorAction };

interface RunMeta {
  backend: RemoveBgBackend;
  totalMs: number;
}

function shouldIgnore(e: unknown): boolean {
  return e instanceof StaleRunError || e instanceof RuntimeClosedError;
}

function readableError(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  return "处理失败，请重试";
}

function formatMiB(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

function backendLabel(backend: RemoveBgBackend): string {
  return backend === "webgpu" ? "WebGPU" : "WASM";
}

function parseHex(hex: string): [number, number, number] {
  const raw = hex.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(raw)) return [255, 255, 255];
  const n = Number.parseInt(raw, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toBackground(choice: BgChoice, customHex: string): ComposeBackground {
  switch (choice) {
    case "transparent":
      return "transparent";
    case "white":
      return [255, 255, 255];
    case "black":
      return [0, 0, 0];
    case "custom":
      return parseHex(customHex);
  }
}

function downloadBasename(filename: string | null): string {
  if (!filename) return "clipboard";
  return filename.replace(/\.[^.]+$/, "") || "image";
}

type GpuNavigator = Navigator & {
  gpu?: { requestAdapter?: () => Promise<unknown> };
};

async function probeWebGpu(): Promise<boolean> {
  const gpu = (navigator as GpuNavigator).gpu;
  if (!gpu || typeof gpu.requestAdapter !== "function") return false;
  try {
    const adapter = await gpu.requestAdapter();
    return adapter != null;
  } catch {
    return false;
  }
}

function zeroCanvas(canvas: HTMLCanvasElement | null): void {
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
}

const BG_CHOICES: { id: BgChoice; label: string }[] = [
  { id: "transparent", label: "透明" },
  { id: "white", label: "白" },
  { id: "black", label: "黑" },
  { id: "custom", label: "自定义" },
];

const checkerStyle: CSSProperties = {
  backgroundColor: "#efece6",
  backgroundImage: "repeating-conic-gradient(#d8d6cf 0% 25%, #f4f3ee 0% 50%)",
  backgroundSize: "16px 16px",
};

export default function RemoveBgClient() {
  const [hasImage, setHasImage] = useState(false);
  const [imageVersion, setImageVersion] = useState(0);
  const [imageError, setImageError] = useState<string | null>(null);
  const [scaledNote, setScaledNote] = useState<string | null>(null);
  const [imageSize, setImageSize] = useState<{ w: number; h: number } | null>(null);
  const [status, setStatus] = useState<UiStatus>({ kind: "idle" });
  const [hasResult, setHasResult] = useState(false);
  const [runMeta, setRunMeta] = useState<RunMeta | null>(null);
  const [activeBackend, setActiveBackend] = useState<RemoveBgBackend | null>(null);
  const [bgChoice, setBgChoice] = useState<BgChoice>("transparent");
  const [customHex, setCustomHex] = useState("#ffffff");
  const [view, setView] = useState<ViewMode>("effect");
  const [holding, setHolding] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const imageGenRef = useRef(0);
  const decodeGenRef = useRef(0);
  const bootGenRef = useRef(0);
  const entryRef = useRef<Ben2RemoveBgModelEntry | null>(null);
  const runtimeRef = useRef<RemoveBgRuntime | null>(null);
  const runtimeDisposeRef = useRef<Promise<void>>(Promise.resolve());
  const backendRef = useRef<RemoveBgBackend | null>(null);
  const sourceRef = useRef<ImageData | null>(null);
  const matteRef = useRef<Uint8ClampedArray | null>(null);
  const composedRef = useRef<ImageData | null>(null);
  const downloadUrlRef = useRef<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<string | null>(null);
  const statusRef = useRef(status);
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const revokeDownloadUrl = useCallback(() => {
    if (downloadUrlRef.current) {
      URL.revokeObjectURL(downloadUrlRef.current);
      downloadUrlRef.current = null;
    }
  }, []);

  const enqueueRuntimeDispose = useCallback((rt: RemoveBgRuntime | null) => {
    const next = runtimeDisposeRef.current
      .catch((e) => {
        console.warn("[remove-bg] 前一 Runtime 释放失败:", readableError(e));
      })
      .then(async () => {
        if (rt) await rt.dispose();
      })
      .catch((e) => {
        console.warn("[remove-bg] Runtime 释放失败:", readableError(e));
      });
    runtimeDisposeRef.current = next;
    return next;
  }, []);

  const disposeRuntime = useCallback(() => {
    const rt = runtimeRef.current;
    runtimeRef.current = null;
    backendRef.current = null;
    setActiveBackend(null);
    return enqueueRuntimeDispose(rt);
  }, [enqueueRuntimeDispose]);

  const reportProgress = useCallback((p: ModelLoadProgress) => {
    const label =
      p.pct !== null && p.pct >= 100
        ? "初始化推理引擎…"
        : p.fromCache
          ? "读取本机缓存…"
          : p.pct === null
            ? "下载模型…"
            : `下载模型 ${Math.round(p.pct)}%`;
    setStatus({
      kind: "loading",
      label,
      pct: p.pct,
      loadedBytes: p.loadedBytes,
      totalBytes: p.totalBytes,
    });
  }, []);

  const runCurrent = useCallback(async (gen: number) => {
    const rt = runtimeRef.current;
    const source = sourceRef.current;
    if (!rt || !source) return;
    setStatus({ kind: "running" });
    setHasResult(false);
    matteRef.current = null;
    composedRef.current = null;
    setDownloadError(null);
    try {
      const out = await rt.run(source);
      if (gen !== imageGenRef.current) return;
      matteRef.current = out.alpha;
      setHasResult(true);
      setRunMeta({ backend: out.backend, totalMs: out.totalMs });
      setStatus({ kind: "ok" });
    } catch (e) {
      if (shouldIgnore(e)) return;
      if (gen !== imageGenRef.current) return;
      setStatus({ kind: "error", message: readableError(e), action: "run" });
    }
  }, []);

  const loadAndRun = useCallback(async () => {
    const rt = runtimeRef.current;
    if (!rt) return;
    const imageGen = imageGenRef.current;
    try {
      await rt.load((progress) => {
        if (runtimeRef.current === rt) reportProgress(progress);
      });
      if (runtimeRef.current !== rt) return;
      if (imageGen !== imageGenRef.current) {
        if (!sourceRef.current) setStatus({ kind: "ok" });
        return;
      }
      if (!sourceRef.current) {
        setStatus({ kind: "ok" });
        return;
      }
      await runCurrent(imageGen);
    } catch (e) {
      if (shouldIgnore(e)) return;
      if (runtimeRef.current !== rt) return;
      if (imageGen !== imageGenRef.current) {
        if (!sourceRef.current) {
          setStatus({ kind: "error", message: readableError(e), action: "load" });
        }
        return;
      }
      const backend = backendRef.current;
      if (backend === "webgpu" && e instanceof BackendUnavailableError) {
        await disposeRuntime();
        if (imageGen !== imageGenRef.current || !sourceRef.current) return;
        setStatus({
          kind: "need-wasm",
          detail: e.message || "WebGPU 初始化失败。",
        });
        return;
      }
      setStatus({ kind: "error", message: readableError(e), action: "load" });
    }
  }, [disposeRuntime, reportProgress, runCurrent]);

  const createLoadAndRun = useCallback(
    async (entry: Ben2RemoveBgModelEntry, backend: RemoveBgBackend, boot: number) => {
      await disposeRuntime();
      if (boot !== bootGenRef.current) return;
      const rt = new RemoveBgRuntime({ entry, backend });
      runtimeRef.current = rt;
      backendRef.current = backend;
      setActiveBackend(backend);
      await loadAndRun();
    },
    [disposeRuntime, loadAndRun],
  );

  const prepare = useCallback(
    async (backend?: RemoveBgBackend) => {
      const boot = ++bootGenRef.current;
      try {
        setStatus({
          kind: "loading",
          label: "正在读取模型配置…",
          pct: null,
          loadedBytes: 0,
          totalBytes: 0,
        });
        let entry = entryRef.current;
        if (!entry) {
          const catalog = await loadModelCatalog();
          if (boot !== bootGenRef.current) return;
          const ben2 = catalog.models.filter(isBen2RemoveBgModelEntry);
          if (ben2.length === 0) {
            throw new ManifestError("没有可用的去背景模型", { path: "models" });
          }
          const recommended = ben2.find((m) => m.recommended);
          if (!recommended) {
            throw new ManifestError("缺少 recommended 的去背景模型", {
              path: "models",
            });
          }
          entry = recommended;
          entryRef.current = entry;
          void pruneAssetCache(catalogCacheKeys(catalog));
        }

        let chosen = backend;
        if (!chosen) {
          const gpuOk = await probeWebGpu();
          if (boot !== bootGenRef.current) return;
          if (!gpuOk) {
            setStatus({
              kind: "need-wasm",
              detail: "当前浏览器没有可用的 WebGPU。",
            });
            return;
          }
          chosen = "webgpu";
        }
        await createLoadAndRun(entry, chosen, boot);
      } catch (e) {
        if (shouldIgnore(e)) return;
        if (boot !== bootGenRef.current) return;
        setStatus({ kind: "error", message: readableError(e), action: "prepare" });
      }
    },
    [createLoadAndRun],
  );

  const afterImageReady = useCallback(() => {
    if (runtimeRef.current) {
      void loadAndRun();
      return;
    }
    const kind = statusRef.current.kind;
    if (kind === "need-wasm") return;
    if (kind === "loading") return;
    void prepare();
  }, [loadAndRun, prepare]);

  const loadImageFile = useCallback(
    (file: File | undefined | null, origin: "file" | "paste") => {
      if (!file) return;
      const decodeId = ++decodeGenRef.current;
      void (async () => {
        try {
          const decoded = await decodeImageFile(file);
          if (decodeId !== decodeGenRef.current) return;
          const gen = ++imageGenRef.current;
          sourceRef.current = decoded.imageData;
          matteRef.current = null;
          composedRef.current = null;
          nameRef.current = origin === "paste" ? null : file.name;
          revokeDownloadUrl();
          setHasResult(false);
          setRunMeta(null);
          setDownloadError(null);
          setImageError(null);
          setImageSize({ w: decoded.imageData.width, h: decoded.imageData.height });
          setScaledNote(
            decoded.scaled
              ? `图片最长边超过 ${MAX_IMAGE_SIDE} 像素，已等比缩小到 ${decoded.imageData.width}×${decoded.imageData.height}`
              : null,
          );
          setView("effect");
          setHolding(false);
          setHasImage(true);
          setImageVersion(gen);
          afterImageReady();
        } catch (e) {
          if (decodeId !== decodeGenRef.current) return;
          setImageError(readableError(e));
        }
      })();
    },
    [afterImageReady, revokeDownloadUrl],
  );

  // 颜色 / 结果变化：只重合成，不推理
  useEffect(() => {
    const source = sourceRef.current;
    const matte = matteRef.current;
    if (!source || !matte || !hasResult) {
      composedRef.current = null;
      return;
    }
    const pixels = compose(source, matte, toBackground(bgChoice, customHex));
    composedRef.current = new ImageData(pixels, source.width, source.height);
  }, [bgChoice, customHex, hasResult, imageVersion]);

  // 预览绘制：显式原图/效果；按住查看原图只切换显示
  useEffect(() => {
    const source = sourceRef.current;
    const canvas = canvasRef.current;
    if (!source || !canvas) return;
    const showSource = view === "source" || holding || !hasResult;
    const data = showSource ? source : (composedRef.current ?? source);
    canvas.width = data.width;
    canvas.height = data.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.putImageData(data, 0, 0);
  }, [view, holding, hasResult, bgChoice, customHex, imageVersion]);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.removeBg = hasImage ? "working" : "idle";
    return () => {
      delete root.dataset.removeBg;
    };
  }, [hasImage]);

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) {
        return;
      }
      const items = e.clipboardData?.items;
      if (items) {
        for (const item of items) {
          if (item.type.startsWith("image/")) {
            const file = item.getAsFile();
            if (file) {
              e.preventDefault();
              loadImageFile(file, "paste");
            }
            return;
          }
        }
      }
      const files = e.clipboardData?.files;
      if (files) {
        for (const file of files) {
          if (file.type.startsWith("image/")) {
            e.preventDefault();
            loadImageFile(file, "paste");
            return;
          }
        }
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [loadImageFile]);

  useEffect(() => {
    const prevent = (e: DragEvent) => e.preventDefault();
    window.addEventListener("dragover", prevent);
    window.addEventListener("drop", prevent);
    return () => {
      window.removeEventListener("dragover", prevent);
      window.removeEventListener("drop", prevent);
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    return () => {
      decodeGenRef.current += 1;
      imageGenRef.current += 1;
      bootGenRef.current += 1;
      const rt = runtimeRef.current;
      runtimeRef.current = null;
      backendRef.current = null;
      void enqueueRuntimeDispose(rt);
      if (downloadUrlRef.current) {
        URL.revokeObjectURL(downloadUrlRef.current);
        downloadUrlRef.current = null;
      }
      zeroCanvas(canvas);
    };
  }, [enqueueRuntimeDispose]);

  const dropHandlers = {
    onDragOver: (e: ReactDragEvent) => {
      e.preventDefault();
      setDragOver(true);
    },
    onDragEnter: (e: ReactDragEvent) => {
      e.preventDefault();
      setDragOver(true);
    },
    onDragLeave: (e: ReactDragEvent) => {
      e.preventDefault();
      setDragOver(false);
    },
    onDrop: (e: ReactDragEvent) => {
      e.preventDefault();
      setDragOver(false);
      loadImageFile(e.dataTransfer.files[0], "file");
    },
  };

  const clearImage = useCallback(() => {
    decodeGenRef.current += 1;
    imageGenRef.current += 1;
    bootGenRef.current += 1;
    sourceRef.current = null;
    matteRef.current = null;
    composedRef.current = null;
    nameRef.current = null;
    revokeDownloadUrl();
    zeroCanvas(canvasRef.current);
    setHasImage(false);
    setHasResult(false);
    setRunMeta(null);
    setImageError(null);
    setScaledNote(null);
    setImageSize(null);
    setDownloadError(null);
    setDragOver(false);
    setHolding(false);
    setView("effect");
    const idle: UiStatus = { kind: "idle" };
    statusRef.current = idle;
    setStatus(idle);
    void disposeRuntime();
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, [disposeRuntime, revokeDownloadUrl]);

  const confirmWasm = useCallback(() => {
    const entry = entryRef.current;
    if (!entry) {
      void prepare("wasm");
      return;
    }
    const boot = ++bootGenRef.current;
    void createLoadAndRun(entry, "wasm", boot);
  }, [createLoadAndRun, prepare]);

  const retry = useCallback(() => {
    const current = statusRef.current;
    if (current.kind !== "error") return;
    if (current.action === "prepare") {
      void prepare();
      return;
    }
    if (current.action === "load") {
      const rt = runtimeRef.current;
      if (rt) {
        void loadAndRun();
        return;
      }
      const entry = entryRef.current;
      const backend = backendRef.current;
      if (entry && backend) {
        void createLoadAndRun(entry, backend, ++bootGenRef.current);
        return;
      }
      void prepare();
      return;
    }
    void runCurrent(imageGenRef.current);
  }, [createLoadAndRun, loadAndRun, prepare, runCurrent]);

  const downloadPng = useCallback(async () => {
    const source = sourceRef.current;
    const matte = matteRef.current;
    if (!source || !matte) return;
    setDownloadError(null);
    const exportCanvas = document.createElement("canvas");
    try {
      const pixels = compose(source, matte, toBackground(bgChoice, customHex));
      const composed = new ImageData(pixels, source.width, source.height);
      exportCanvas.width = source.width;
      exportCanvas.height = source.height;
      const ctx = exportCanvas.getContext("2d");
      if (!ctx) throw new Error("无法导出 PNG，请重试");
      ctx.putImageData(composed, 0, 0);
      const blob = await new Promise<Blob | null>((resolve) => {
        exportCanvas.toBlob(resolve, "image/png");
      });
      if (!blob) throw new Error("无法导出 PNG，请重试");
      revokeDownloadUrl();
      const url = URL.createObjectURL(blob);
      downloadUrlRef.current = url;
      const a = document.createElement("a");
      a.href = url;
      a.download = `${downloadBasename(nameRef.current)}-remove-bg.png`;
      a.click();
      window.setTimeout(() => {
        if (downloadUrlRef.current === url) revokeDownloadUrl();
      }, 1000);
    } catch (e) {
      setDownloadError(readableError(e));
    } finally {
      zeroCanvas(exportCanvas);
    }
  }, [bgChoice, customHex, revokeDownloadUrl]);

  const openFilePicker = () => fileInputRef.current?.click();

  const onHoldPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (!hasResult) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setHolding(true);
  };
  const onHoldPointerUp = () => setHolding(false);

  const showSource = view === "source" || holding;
  const busy = status.kind === "loading" || status.kind === "running";
  const displayBackend = runMeta?.backend ?? activeBackend;

  return (
    <div className={`flex flex-col ${hasImage ? "lg:h-dvh lg:overflow-hidden" : "min-h-dvh"}`}>
      <SiteHeader current="remove-bg" />

      {!hasImage ? (
        <main className="mx-auto flex w-full max-w-[1600px] flex-1 flex-col px-4">
          <section className="pb-8 pt-12 text-center sm:pb-10 sm:pt-20">
            <h2 className="text-[26px] font-semibold tracking-tight sm:text-[32px]">
              背景去除
            </h2>
            <p className="mt-3 text-[15px] text-muted">
              粘贴、拖入或选择图片，抠图过程完全在本机完成。
            </p>
          </section>

          <section className="mx-auto w-full max-w-3xl">
            <div
              role="button"
              tabIndex={0}
              aria-label="上传图片"
              onClick={openFilePicker}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  openFilePicker();
                }
              }}
              {...dropHandlers}
              className={`flex min-h-[220px] cursor-pointer items-center justify-center rounded-[10px] border-[1.5px] border-dashed transition-[border-color,background-color,scale] duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-ink active:scale-[0.99] sm:min-h-[320px] ${
                dragOver
                  ? "border-accent bg-accent/[0.05]"
                  : "border-border bg-panel [@media(hover:hover)]:hover:border-accent/70"
              }`}
            >
              <div className="pointer-events-none flex flex-col items-center gap-3 px-6 text-center">
                <svg
                  width="36"
                  height="36"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                  className="text-muted/40"
                >
                  <rect x="3" y="4" width="18" height="16" rx="2.5" />
                  <circle cx="9" cy="10" r="1.6" />
                  <path d="m21 15.5-4.8-4.8L7 20" />
                </svg>
                <p className="text-[14px] text-text">
                  <span className="[@media(hover:none)]:hidden">
                    拖入图片、点击选择，或直接 <span className="font-mono">Ctrl/⌘V</span> 粘贴
                  </span>
                  <span className="hidden [@media(hover:none)]:inline">点按选择图片</span>
                </p>
                <p className="font-mono text-[11px] text-muted">
                  PNG / JPG / WebP · 最大 50 MB / 16,777,216 像素
                </p>
              </div>
            </div>

            <div
              aria-live="polite"
              className="mt-5 flex min-h-[56px] flex-col items-center justify-center gap-2 text-center"
            >
              {status.kind === "loading" ? (
                <>
                  <p className="text-[13px] text-muted">{status.label}</p>
                  {status.totalBytes > 0 && (
                    <p className="font-mono text-[12px] tabular-nums text-muted">
                      {status.pct !== null ? `${Math.round(status.pct)}% · ` : ""}
                      {formatMiB(status.loadedBytes)} / {formatMiB(status.totalBytes)} MiB
                    </p>
                  )}
                  <div className="h-1 w-56 overflow-hidden rounded-full bg-border">
                    {status.pct !== null ? (
                      <div
                        className="h-full rounded-full bg-accent transition-[width] duration-150"
                        style={{ width: `${status.pct}%` }}
                      />
                    ) : (
                      <div className="h-full w-full animate-pulse rounded-full bg-accent" />
                    )}
                  </div>
                </>
              ) : status.kind === "error" ? (
                <>
                  <p className="text-[13px] text-err">{status.message}</p>
                  <button type="button" onClick={retry} className={secondaryBtn}>
                    重试
                  </button>
                </>
              ) : status.kind === "need-wasm" ? (
                <>
                  <p className="text-[13px] text-muted">
                    {status.detail} 可改用兼容模式，速度会明显更慢。
                  </p>
                  <button type="button" onClick={confirmWasm} className={primaryBtn}>
                    确认兼容模式
                  </button>
                </>
              ) : (
                <p className="text-[13px] text-muted">选择图片后开始处理</p>
              )}
              {imageError && <p className="text-[13px] text-err">{imageError}</p>}
            </div>
          </section>

          <p className="mt-auto pb-8 pt-10 text-center text-[12px] text-muted">
            100% 本地运行 · 图片不上传
          </p>
        </main>
      ) : (
        <main className="mx-auto grid w-full max-w-[1600px] flex-1 grid-cols-1 gap-3 p-3 sm:gap-4 sm:p-4 lg:min-h-0 lg:grid-cols-[minmax(0,1fr)_320px] lg:grid-rows-[minmax(0,1fr)] lg:overflow-hidden">
          <section className="flex flex-col overflow-hidden rounded-[10px] border border-border bg-panel lg:min-h-0">
            <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2.5">
              <h2 className="text-[13px] font-semibold tracking-tight">
                {showSource ? "原图" : "效果"}
              </h2>
              <span
                className={`text-[11px] ${imageError ? "text-err" : "hidden text-muted lg:inline"}`}
              >
                {imageError ?? "拖入新图片或 Ctrl/⌘V 粘贴可替换"}
              </span>
            </div>
            <div
              {...dropHandlers}
              className={`flex flex-1 items-center justify-center overflow-hidden p-3 transition-[background-color] duration-150 sm:p-4 lg:min-h-0 ${
                dragOver ? "bg-accent/[0.05]" : ""
              }`}
            >
              <canvas
                ref={canvasRef}
                style={checkerStyle}
                onPointerDown={onHoldPointerDown}
                onPointerUp={onHoldPointerUp}
                onPointerCancel={onHoldPointerUp}
                onLostPointerCapture={onHoldPointerUp}
                className={`max-h-[50vh] max-w-full rounded-[4px] object-contain touch-none lg:max-h-full ${
                  dragOver ? "opacity-40" : ""
                } ${hasResult ? "cursor-pointer" : ""}`}
              />
            </div>
          </section>

          <aside className="flex flex-col overflow-hidden rounded-[10px] border border-border bg-panel lg:min-h-0">
            <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2.5">
              <h2 className="text-[13px] font-semibold tracking-tight">控制</h2>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain p-4">
              <div>
                <p className="mb-2 text-[12px] font-medium text-muted">背景</p>
                <div className="grid grid-cols-2 gap-2">
                  {BG_CHOICES.map((choice) => {
                    const active = bgChoice === choice.id;
                    return (
                      <button
                        key={choice.id}
                        type="button"
                        aria-pressed={active}
                        onClick={() => setBgChoice(choice.id)}
                        className={`${secondaryBtn} ${
                          active ? "border-accent text-accent-ink" : ""
                        }`}
                      >
                        {choice.label}
                      </button>
                    );
                  })}
                </div>
                {bgChoice === "custom" && (
                  <label className="mt-2 flex min-h-11 items-center gap-2 text-[13px]">
                    <span className="text-muted">颜色</span>
                    <input
                      type="color"
                      value={customHex}
                      onChange={(e) => setCustomHex(e.target.value)}
                      className="h-11 w-11 cursor-pointer rounded-[8px] border border-border bg-panel p-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-ink"
                    />
                    <span className="font-mono text-[12px] text-muted">{customHex}</span>
                  </label>
                )}
              </div>

              <div>
                <p className="mb-2 text-[12px] font-medium text-muted">预览</p>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    aria-pressed={view === "effect"}
                    onClick={() => setView("effect")}
                    className={`${secondaryBtn} ${view === "effect" ? "border-accent text-accent-ink" : ""}`}
                  >
                    效果
                  </button>
                  <button
                    type="button"
                    aria-pressed={view === "source"}
                    onClick={() => setView("source")}
                    className={`${secondaryBtn} ${view === "source" ? "border-accent text-accent-ink" : ""}`}
                  >
                    原图
                  </button>
                </div>
                <button
                  type="button"
                  disabled={!hasResult}
                  onPointerDown={onHoldPointerDown}
                  onPointerUp={onHoldPointerUp}
                  onPointerCancel={onHoldPointerUp}
                  onLostPointerCapture={onHoldPointerUp}
                  className={`${secondaryBtn} mt-2 w-full touch-none`}
                >
                  按住查看原图
                </button>
              </div>

              <div aria-live="polite" className="flex flex-col gap-1.5 text-[12px] text-muted">
                {imageSize && (
                  <p>
                    尺寸{" "}
                    <span className="font-mono tabular-nums text-text">
                      {imageSize.w} × {imageSize.h}
                    </span>
                  </p>
                )}
                {displayBackend && (
                  <p>
                    后端{" "}
                    <span className="font-mono text-text">
                      {backendLabel(displayBackend)}
                      {displayBackend === "wasm" ? " · 兼容模式" : ""}
                    </span>
                  </p>
                )}
                {runMeta && (
                  <p>
                    总耗时{" "}
                    <span className="font-mono tabular-nums text-text">
                      {formatMs(runMeta.totalMs)}
                    </span>
                  </p>
                )}
                {scaledNote && <p>{scaledNote}</p>}
                {status.kind === "loading" && (
                  <>
                    <p>{status.label}</p>
                    {status.totalBytes > 0 && (
                      <p className="font-mono tabular-nums">
                        {status.pct !== null ? `${Math.round(status.pct)}% · ` : ""}
                        {formatMiB(status.loadedBytes)} / {formatMiB(status.totalBytes)} MiB
                      </p>
                    )}
                    <div className="mt-1 h-1 overflow-hidden rounded-full bg-border">
                      {status.pct !== null ? (
                        <div
                          className="h-full rounded-full bg-accent transition-[width] duration-150"
                          style={{ width: `${status.pct}%` }}
                        />
                      ) : (
                        <div className="h-full w-full animate-pulse rounded-full bg-accent" />
                      )}
                    </div>
                  </>
                )}
                {status.kind === "running" && <p>正在处理…</p>}
                {status.kind === "need-wasm" && (
                  <p className="text-text">
                    {status.detail} 确认后将使用 WebAssembly 兼容模式，速度会明显更慢，不承诺同等体验。
                  </p>
                )}
                {status.kind === "error" && <p className="text-err">{status.message}</p>}
                {downloadError && <p className="text-err">{downloadError}</p>}
                {imageError && <p className="text-err">{imageError}</p>}
              </div>

              {status.kind === "need-wasm" && (
                <button type="button" onClick={confirmWasm} className={primaryBtn}>
                  确认兼容模式
                </button>
              )}
              {status.kind === "error" && (
                <button type="button" onClick={retry} className={secondaryBtn}>
                  重试
                </button>
              )}

              <div className="mt-auto flex flex-col gap-2 border-t border-border pt-4">
                <button
                  type="button"
                  onClick={() => void downloadPng()}
                  disabled={!hasResult || busy}
                  className={primaryBtn}
                >
                  下载 PNG
                </button>
                <button
                  type="button"
                  onClick={clearImage}
                  className={secondaryBtn}
                >
                  清空图片
                </button>
              </div>
            </div>
          </aside>
        </main>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
        className="hidden"
        onChange={(e) => {
          loadImageFile(e.target.files?.[0], "file");
          e.target.value = "";
        }}
      />
    </div>
  );
}
