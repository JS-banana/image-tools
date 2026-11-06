"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  RuntimeBusyError,
  RuntimeClosedError,
  StaleSelectionError,
  type ModelState,
  type OcrLine,
} from "@img/ocr";
import { createOcrClient } from "@/lib/tool-engines";
import { decodeImageFile } from "@/shared/browser-image/decode";
import { useImageInput, type ImageOrigin } from "@/shared/browser-image/use-image-input";
import { TaskScope } from "@/shared/task-scope";
import { OCR_IMAGE_POLICY } from "./image-policy";
import { cardText, toUiModel, type CardProgress, type CardStatus, type UiModel } from "./presentation";

type OcrClient = Awaited<ReturnType<typeof createOcrClient>>;
type ResultsState =
  | { kind: "idle" | "no-text" | "no-valid" }
  | { kind: "error"; message: string };
interface SourceImage {
  image: ImageData;
  name: string | null;
  version: number;
}
interface RunMeta {
  totalMs: number;
  detMs: number;
  recMs: number;
  backend: string;
}

/** Owns user workflow only. Model configuration, caching and sessions stay in the client. */
export function useOcrController() {
  const [models, setModels] = useState<UiModel[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [cardStatus, setCardStatus] = useState<Record<string, CardStatus>>({});
  const [cardProgress, setCardProgress] = useState<Record<string, CardProgress>>({});
  const [statusText, setStatusText] = useState("正在读取模型配置…");
  const [statusKind, setStatusKind] = useState<"" | "ok" | "loading">("loading");
  const [manifestError, setManifestError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [running, setRunning] = useState(false);
  const [source, setSource] = useState<SourceImage | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const [results, setResults] = useState<OcrLine[] | null>(null);
  const [resultsState, setResultsState] = useState<ResultsState>({ kind: "idle" });
  const [runMeta, setRunMeta] = useState<RunMeta | null>(null);
  const [runProgress, setRunProgress] = useState<{ pct: number; label: string } | null>(null);
  const [copyState, setCopyState] = useState<"" | "ok" | "err">("");

  const runtimeRef = useRef<OcrClient | null>(null);
  const sourceRef = useRef<SourceImage | null>(null);
  const currentIdRef = useRef<string | null>(null);
  const runningRef = useRef(false);
  const imageVersionRef = useRef(0);
  const cardRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastAutoRanVersionRef = useRef<number | null>(null);
  const lifecycle = useRef(new TaskScope());
  const decodes = useRef(new TaskScope());
  const runs = useRef(new TaskScope());
  const selections = useRef(new TaskScope());

  const resetResults = useCallback(() => {
    runs.current.invalidate();
    setResults(null);
    setResultsState({ kind: "idle" });
    setRunMeta(null);
    setRunProgress(null);
    setCopyState("");
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    lastAutoRanVersionRef.current = null;
  }, []);

  const selectModel = useCallback(async (model: UiModel) => {
    const runtime = runtimeRef.current;
    if (!runtime || runningRef.current) return;
    if (currentIdRef.current === model.id && runtime.state(model.id).phase === "ready") return;
    const ticket = selections.current.next();
    currentIdRef.current = model.id;
    setCurrentId(model.id);
    resetResults();
    setReady(false);
    setStatusText(`正在加载模型：${model.label}`);
    setStatusKind("loading");
    try {
      await runtime.select(model.id);
      if (!ticket.isCurrent() || runtimeRef.current !== runtime) return;
      // Selecting a resident model reuses its session and emits no new ready event.
      const state = runtime.state(model.id);
      setReady(state.phase === "ready");
      setCardStatus((previous) => ({ ...previous, [model.id]: cardText(state) }));
      if (state.phase === "ready") {
        setStatusText("模型已就绪");
        setStatusKind("ok");
      }
    } catch (error) {
      if (!ticket.isCurrent() || runtimeRef.current !== runtime) return;
      if (error instanceof StaleSelectionError || error instanceof RuntimeClosedError) return;
      if (error instanceof RuntimeBusyError) {
        const actual = runtime.selectedId();
        currentIdRef.current = actual;
        setCurrentId(actual);
        if (actual) {
          const state = runtime.state(actual);
          setReady(state.phase === "ready");
          setStatusText(state.phase === "ready" ? "模型已就绪" : "模型加载中…");
          setStatusKind(state.phase === "ready" ? "ok" : "loading");
        }
        return;
      }
      console.error(error);
    }
  }, [resetResults]);

  useEffect(() => {
    const ticket = lifecycle.current.next();
    const decodeScope = decodes.current;
    const runScope = runs.current;
    const selectionScope = selections.current;
    let ownedRuntime: OcrClient | null = null;
    const readyCount: Record<string, number> = {};

    const applyState = (id: string, state: ModelState) => {
      if (!ticket.isCurrent()) return;
      if (state.phase === "ready") readyCount[id] = (readyCount[id] ?? 0) + 1;
      setCardStatus((previous) => ({ ...previous, [id]: cardText(state) }));
      if (state.phase === "ready" || state.phase === "failed") {
        setCardProgress((previous) => {
          if (!(id in previous)) return previous;
          const next = { ...previous };
          delete next[id];
          return next;
        });
      }
      if (id !== currentIdRef.current) return;
      setReady(state.phase === "ready");
      if (state.phase === "ready") {
        setStatusText("模型已就绪");
        setStatusKind("ok");
      } else if (state.phase === "failed") {
        setStatusText(`模型加载失败：${state.error ?? "未知错误"}`);
        setStatusKind("");
      } else if (state.phase === "loading") {
        setStatusKind("loading");
      }
    };

    void (async () => {
      try {
        const runtime = await createOcrClient({
          onState: applyState,
          onLoadProgress: (id, progress) => {
            if (!ticket.isCurrent()) return;
            const value: CardProgress = {
              pct: progress.pct,
              label: progress.pct !== null && progress.pct >= 100
                ? "初始化推理引擎…"
                : progress.fromCache
                  ? "读取本机缓存…"
                  : progress.pct === null
                    ? "下载模型…"
                    : `下载模型 ${Math.round(progress.pct)}%`,
            };
            setCardProgress((previous) => ({ ...previous, [id]: value }));
            if (id === currentIdRef.current) {
              setStatusKind("loading");
              setStatusText(value.label);
            }
          },
        });
        ownedRuntime = runtime;
        if (!ticket.isCurrent()) {
          await runtime.dispose();
          return;
        }
        runtimeRef.current = runtime;
        const list = runtime.models.map(toUiModel);
        setModels(list);
        if (process.env.NODE_ENV !== "production") {
          (window as unknown as { __ocrDebug?: unknown }).__ocrDebug = { rt: runtime, readyCount };
        }
        // Preserve Tiny preloading as an OCR-page policy, outside the site shell.
        const recommended = list.find((model) => model.recommended) ?? list[0];
        if (recommended) void selectModel(recommended);
      } catch (error) {
        if (!ticket.isCurrent()) return;
        setManifestError(error instanceof Error ? error.message : String(error));
        setStatusText("模型配置加载失败");
        setStatusKind("");
      }
    })();

    const scope = lifecycle.current;
    return () => {
      scope.invalidate();
      decodeScope.invalidate();
      runScope.invalidate();
      selectionScope.invalidate();
      if (runtimeRef.current === ownedRuntime) runtimeRef.current = null;
      runningRef.current = false;
      sourceRef.current = null;
      if (ownedRuntime) void ownedRuntime.dispose();
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      if (process.env.NODE_ENV !== "production") {
        delete (window as unknown as { __ocrDebug?: unknown }).__ocrDebug;
      }
    };
  }, [selectModel]);

  const loadImageFile = useCallback((file: File | null | undefined, origin: ImageOrigin) => {
    if (!file) return;
    const ticket = decodes.current.next();
    void (async () => {
      try {
        const decoded = await decodeImageFile(file, OCR_IMAGE_POLICY);
        if (!ticket.isCurrent()) return;
        const next: SourceImage = {
          image: decoded.imageData,
          name: origin === "paste" ? null : file.name,
          version: ++imageVersionRef.current,
        };
        resetResults();
        sourceRef.current = next;
        setSource(next);
        setImageError(null);
      } catch (error) {
        if (!ticket.isCurrent()) return;
        setImageError(error instanceof Error ? error.message : "图片读取失败，请重试");
      }
    })();
  }, [resetResults]);

  const input = useImageInput(loadImageFile);
  const { resetInput } = input;

  const runOCR = useCallback(async () => {
    const runtime = runtimeRef.current;
    const image = sourceRef.current;
    const selected = currentIdRef.current;
    if (!runtime || !image || !selected || runningRef.current) return;
    if (runtime.state(selected).phase !== "ready") return;
    const ticket = runs.current.next();
    const owner = lifecycle.current.capture();
    runningRef.current = true;
    setRunning(true);
    setCopyState("");
    try {
      const output = await runtime.run(image.image, (progress) => {
        if (ticket.isCurrent() && owner.isCurrent()) setRunProgress(progress);
      });
      if (!ticket.isCurrent() || !owner.isCurrent()) return;
      setRunProgress(null);
      if (output.boxesFound === 0) {
        setResults(null);
        setRunMeta(null);
        setResultsState({ kind: "no-text" });
      } else {
        setResults(output.results);
        setRunMeta({
          totalMs: output.totalMs,
          detMs: output.detMs,
          recMs: output.recMs,
          backend: output.backend,
        });
        setResultsState({ kind: output.results.length === 0 ? "no-valid" : "idle" });
      }
    } catch (error) {
      if (!ticket.isCurrent() || !owner.isCurrent()) return;
      if (error instanceof RuntimeClosedError) return;
      console.error(error);
      setRunProgress(null);
      setResults(null);
      setRunMeta(null);
      setResultsState({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      // A newer image waits for this run to settle, but never accepts its output.
      if (owner.isCurrent() && runtimeRef.current === runtime) {
        runningRef.current = false;
        setRunning(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!source || !ready || running || lastAutoRanVersionRef.current === source.version) return;
    lastAutoRanVersionRef.current = source.version;
    void runOCR();
  }, [source, ready, running, runOCR]);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.ocr = source ? "working" : "idle";
    return () => { delete root.dataset.ocr; };
  }, [source]);

  const copyAll = useCallback(async () => {
    if (!results?.length) return;
    const ticket = runs.current.capture();
    const owner = lifecycle.current.capture();
    try {
      await navigator.clipboard.writeText(results.map((line) => line.text).join("\n"));
      if (!ticket.isCurrent() || !owner.isCurrent()) return;
      setCopyState("ok");
    } catch (error) {
      if (!ticket.isCurrent() || !owner.isCurrent()) return;
      console.error(error);
      setCopyState("err");
    }
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopyState(""), 1600);
  }, [results]);

  const downloadTxt = useCallback(() => {
    if (!results?.length) return;
    const name = sourceRef.current?.name;
    const blob = new Blob([results.map((line) => line.text).join("\n")], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name ? `${name.replace(/\.[^.]+$/, "")}-ocr.txt` : "clipboard-ocr.txt";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [results]);

  const clearImage = useCallback(() => {
    decodes.current.invalidate();
    sourceRef.current = null;
    setSource(null);
    setImageError(null);
    resetResults();
    resetInput();
  }, [resetResults, resetInput]);

  const onModelGroupKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (running || models.length === 0) return;
    const index = models.findIndex((model) => model.id === currentId);
    let next = -1;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") next = (index + 1) % models.length;
    else if (event.key === "ArrowUp" || event.key === "ArrowLeft") next = (index - 1 + models.length) % models.length;
    if (next < 0) return;
    event.preventDefault();
    cardRefs.current[models[next].id]?.focus();
    void selectModel(models[next]);
  };

  const currentModel = models.find((model) => model.id === currentId) ?? null;
  const runLabel = running ? "识别中…" : !ready ? "模型加载中…" : results ? "重新识别" : `使用 ${currentModel?.label ?? ""} 识别`;
  return {
    ...input,
    models, currentId, currentModel,
    currentProgress: currentId ? cardProgress[currentId] : undefined,
    cardStatus, cardProgress, cardRefs,
    statusText, statusKind, manifestError, ready, running,
    image: source?.image ?? null, hasImage: source !== null, imageError,
    results, resultsState, runMeta, runProgress, copyState, runLabel,
    loadImageFile, selectModel, runOCR, copyAll, downloadTxt, clearImage, onModelGroupKeyDown,
  };
}
