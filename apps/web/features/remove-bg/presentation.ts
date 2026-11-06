import type { ComposeBackground, RemoveBgBackend } from "@img/remove-bg";

export type BgChoice = "transparent" | "white" | "black" | "custom";
export type ViewMode = "effect" | "source";
export type ErrorAction = "prepare" | "load" | "run";
export type UiStatus =
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

export interface RunMeta {
  backend: RemoveBgBackend;
  totalMs: number;
}

export const BG_CHOICES: { id: BgChoice; label: string }[] = [
  { id: "transparent", label: "透明" },
  { id: "white", label: "白" },
  { id: "black", label: "黑" },
  { id: "custom", label: "自定义" },
];

export function readableError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "处理失败，请重试";
}

export function formatMiB(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

export function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

export function backendLabel(backend: RemoveBgBackend): string {
  return backend === "webgpu" ? "WebGPU" : "WASM";
}

export function toBackground(choice: BgChoice, customHex: string): ComposeBackground {
  if (choice === "transparent") return "transparent";
  if (choice === "black") return [0, 0, 0];
  if (choice === "white") return [255, 255, 255];
  const raw = customHex.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(raw)) return [255, 255, 255];
  const color = Number.parseInt(raw, 16);
  return [(color >> 16) & 255, (color >> 8) & 255, color & 255];
}

export function downloadBasename(filename: string | null): string {
  return filename ? filename.replace(/\.[^.]+$/, "") || "image" : "clipboard";
}
