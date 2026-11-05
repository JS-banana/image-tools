import type { ModelState } from "@img/ocr";
import type { ModelSummary } from "@img/model-runtime";

export interface UiModel extends ModelSummary {
  sizeMB: number;
}

export interface CardStatus {
  text: string;
  kind: "ok" | "err" | "loading" | "";
}

export interface CardProgress {
  pct: number | null;
  label: string;
}

export const BOX_COLORS = ["#2f7de1", "#2f9e63", "#e8912d", "#8b5cf6"];

export function toUiModel(summary: ModelSummary): UiModel {
  return { ...summary, sizeMB: Math.round(summary.downloadBytes / (1024 * 1024)) };
}

export function cardText(state: ModelState): CardStatus {
  switch (state.phase) {
    case "loading":
      return { text: "加载中…", kind: "loading" };
    case "ready":
      return { text: state.source === "cache" ? "就绪 · 已缓存" : "就绪", kind: "ok" };
    case "failed":
      return { text: "加载失败 · 点击重试", kind: "err" };
    default:
      return { text: "未加载", kind: "" };
  }
}
