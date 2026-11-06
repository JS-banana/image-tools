"use client";

import { SiteHeader } from "@/components/site-header";
import { OcrPreview } from "./OcrPreview";
import { useOcrController } from "./use-ocr-controller";
import { BOX_COLORS } from "./presentation";

// 窄屏下抬到 44px 触控目标，桌面维持原有紧凑高度
const primaryBtn =
  "min-h-11 rounded-[8px] bg-accent px-4 py-2.5 text-[13px] font-medium text-[#171717] transition-[opacity,scale] duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-ink enabled:[@media(hover:hover)]:hover:opacity-90 enabled:active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 lg:min-h-0";
const secondaryBtn =
  "min-h-11 rounded-[8px] border border-border bg-panel px-4 py-2.5 text-[13px] font-medium text-text transition-[border-color,scale] duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-ink enabled:[@media(hover:hover)]:hover:border-accent/70 enabled:active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 lg:min-h-0";

export default function OcrWorkspace() {
  const {
    models, currentId, currentModel, currentProgress, cardStatus, cardProgress,
    cardRefs, statusText, statusKind, manifestError, ready, running, hasImage,
    image, imageError, results, resultsState, runMeta, runProgress, copyState,
    runLabel, fileInputRef, dragOver, dropHandlers, selectModel, loadImageFile,
    runOCR, copyAll, downloadTxt, clearImage, onModelGroupKeyDown,
  } = useOcrController();

  // ===== 渲染 =====
  // 桌面工作态锁定视口高度、各栏内滚动；窄屏改为整页滚动的堆叠布局
  return (
    <div
      className={`flex flex-col ${
        hasImage ? "lg:h-dvh lg:overflow-hidden" : "min-h-dvh"
      }`}
    >
      {/* ===== 顶部栏（站点共用组件，含工具切换导航） ===== */}
      <SiteHeader current="ocr" />

      {!hasImage ? (
        /* ===== 初始上传状态 ===== */
        <main className="mx-auto flex w-full max-w-[1600px] flex-1 flex-col px-4">
          <section className="pb-8 pt-12 text-center sm:pb-10 sm:pt-20">
            {/* h1 由 site-content.tsx 承担（此处在 ssr:false 边界内，不进静态 HTML） */}
            <h2 className="text-[26px] font-semibold tracking-tight sm:text-[32px]">
              图片文字识别
            </h2>
            <p className="mt-3 text-[15px] text-muted">
              粘贴、拖入或选择图片，识别过程完全在本机完成。
            </p>
          </section>

          <section className="mx-auto w-full max-w-3xl">
            <div
              role="button"
              tabIndex={0}
              aria-label="上传图片"
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  fileInputRef.current?.click();
                }
              }}
              {...dropHandlers}
              className={`flex min-h-[220px] cursor-pointer items-center justify-center rounded-[10px] border-[1.5px] border-dashed transition-[border-color,background-color] duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-ink sm:min-h-[320px] ${
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
                  <span className="hidden [@media(hover:none)]:inline">
                    点按选择图片，或从相册、相机导入
                  </span>
                </p>
                <p className="font-mono text-[11px] text-muted">
                  PNG / JPG / WebP · 最大 50 MB / 33,554,432 像素
                </p>
              </div>
            </div>

            {/* 模型状态（aria-live 播报） */}
            <div
              aria-live="polite"
              className="mt-5 flex min-h-[56px] flex-col items-center justify-center gap-2 text-center"
            >
              {manifestError ? (
                <>
                  <p className="text-[13px] text-err">模型配置加载失败:{manifestError}</p>
                  <button
                    type="button"
                    onClick={() => window.location.reload()}
                    className={secondaryBtn}
                  >
                    刷新重试
                  </button>
                </>
              ) : statusKind === "loading" ? (
                <>
                  <p className="text-[13px] text-muted">{statusText}</p>
                  <div className="h-1 w-56 overflow-hidden rounded-full bg-border">
                    {currentProgress && currentProgress.pct !== null ? (
                      <div
                        className="h-full rounded-full bg-accent transition-[width] duration-150"
                        style={{ width: `${currentProgress.pct}%` }}
                      />
                    ) : (
                      <div className="h-full w-full animate-pulse rounded-full bg-accent" />
                    )}
                  </div>
                </>
              ) : statusKind === "ok" ? (
                <p className="text-[13px] text-muted">模型已就绪，上传图片即可识别</p>
              ) : (
                <>
                  <p className="text-[13px] text-err">{statusText}</p>
                  {currentModel && (
                    <button
                      type="button"
                      onClick={() => void selectModel(currentModel)}
                      className={secondaryBtn}
                    >
                      重试
                    </button>
                  )}
                </>
              )}
              {imageError && <p className="text-[13px] text-err">{imageError}</p>}
            </div>
          </section>

          <p className="mt-auto pb-8 pt-10 text-center text-[12px] text-muted">
            100% 本地运行 · 图片不上传
          </p>
        </main>
      ) : (
        /* ===== 识别工作区（固定视口高度，三栏内滚动） ===== */
        <main className="mx-auto grid w-full max-w-[1600px] flex-1 grid-cols-1 gap-3 p-3 sm:gap-4 sm:p-4 lg:min-h-0 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_320px] lg:grid-rows-[minmax(0,1fr)] lg:overflow-hidden">
          {/* 左栏：原图与标注框 */}
          <section className="flex flex-col overflow-hidden rounded-[10px] border border-border bg-panel lg:min-h-0">
            <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2.5">
              <h2 className="text-[13px] font-semibold tracking-tight">原图</h2>
              <span
                className={`text-[11px] ${
                  imageError ? "text-err" : "hidden text-muted lg:inline"
                }`}
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
              <OcrPreview image={image} results={results} dragOver={dragOver} />
            </div>
          </section>

          {/* 中栏：逐行文字与置信度 */}
          <section className="flex flex-col overflow-hidden rounded-[10px] border border-border bg-panel lg:min-h-0">
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-2.5">
              <h2 className="text-[13px] font-semibold tracking-tight">识别结果</h2>
              {currentModel && (
                <span className="truncate text-[11px] text-muted">
                  {currentModel.label} ·{" "}
                  <span className="font-mono">{currentModel.name}</span>
                </span>
              )}
            </div>
            {runProgress && (
              <div className="shrink-0 border-b border-border px-4 py-2.5" aria-live="polite">
                <div className="mb-1.5 flex items-center justify-between text-[11px] text-muted">
                  <span>{runProgress.label}</span>
                  <span className="font-mono tabular-nums">
                    {Math.round(runProgress.pct)}%
                  </span>
                </div>
                <div className="h-1 overflow-hidden rounded-full bg-border">
                  <div
                    className="h-full rounded-full bg-accent transition-[width] duration-150"
                    style={{ width: `${runProgress.pct}%` }}
                  />
                </div>
              </div>
            )}
            <div className="max-h-[60vh] min-h-[160px] flex-1 overflow-y-auto overscroll-contain p-2 lg:max-h-none lg:min-h-0">
              {results && results.length > 0 ? (
                results.map((r, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-2.5 rounded-[6px] px-2.5 py-2 [@media(hover:hover)]:hover:bg-bg"
                  >
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-[3px]"
                      style={{ background: BOX_COLORS[i % BOX_COLORS.length] }}
                      aria-hidden="true"
                    />
                    <span className="w-6 shrink-0 text-right font-mono text-[11px] text-muted">
                      {i + 1}
                    </span>
                    <span className="min-w-0 flex-1 break-all text-[13.5px] leading-relaxed">
                      {r.text}
                    </span>
                    <span
                      className={`shrink-0 font-mono text-[11.5px] tabular-nums ${
                        r.confidence < 0.8 ? "text-accent-ink" : "text-muted"
                      }`}
                    >
                      {(r.confidence * 100).toFixed(1)}%
                    </span>
                  </div>
                ))
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
                  <p
                    className={`text-[13px] ${
                      resultsState.kind === "error" ? "text-err" : "text-muted"
                    }`}
                  >
                    {resultsState.kind === "no-text"
                      ? "未检测到文本，请尝试更清晰的图片"
                      : resultsState.kind === "no-valid"
                        ? "检测到文本区域，但没有识别出有效文字"
                        : resultsState.kind === "error"
                          ? `识别失败：${resultsState.message}`
                          : running
                            ? "正在识别…"
                            : !ready
                              ? "模型加载完成后将自动识别"
                              : "准备识别…"}
                  </p>
                </div>
              )}
            </div>
            <div className="shrink-0 border-t border-border px-4 py-2.5">
              <div className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-muted/70">
                运行详情
              </div>
              <div className="mt-0.5 font-mono text-[11px] text-muted">
                {runMeta
                  ? `总耗时 ${Math.round(runMeta.totalMs)}ms · 检测 ${Math.round(runMeta.detMs)}ms · 识别 ${Math.round(runMeta.recMs)}ms · ${runMeta.backend}`
                  : "—"}
              </div>
            </div>
          </section>

          {/* 右栏：模型与操作 */}
          <aside className="flex flex-col overflow-hidden rounded-[10px] border border-border bg-panel lg:min-h-0">
            <div className="border-b border-border px-4 py-2.5">
              <h2 className="text-[13px] font-semibold tracking-tight">模型</h2>
            </div>
            <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4 lg:min-h-0">
              <div
                role="radiogroup"
                aria-label="选择识别模型"
                onKeyDown={onModelGroupKeyDown}
                className="flex flex-col gap-2"
              >
                {models.map((m) => {
                  const st = cardStatus[m.id];
                  const prog = cardProgress[m.id];
                  const active = currentId === m.id;
                  return (
                    <button
                      key={m.id}
                      ref={(el) => {
                        cardRefs.current[m.id] = el;
                      }}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      tabIndex={active ? 0 : -1}
                      disabled={running}
                      onClick={() => void selectModel(m)}
                      className={`w-full rounded-[8px] border px-3.5 py-3 text-left transition-[border-color,background-color] duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-ink disabled:cursor-not-allowed disabled:opacity-55 ${
                        active
                          ? "border-accent bg-accent/[0.05]"
                          : "border-border bg-panel [@media(hover:hover)]:hover:border-accent/60"
                      }`}
                    >
                      <div className="flex items-center gap-2.5">
                        <span
                          className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                            active ? "border-accent" : "border-border"
                          }`}
                          aria-hidden="true"
                        >
                          {active && <span className="h-2 w-2 rounded-full bg-accent" />}
                        </span>
                        <span className="text-[13.5px] font-semibold tracking-tight">
                          {m.label}
                        </span>
                        {m.recommended && (
                          <span className="rounded-full bg-bg px-1.5 py-px text-[10px] text-muted">
                            推荐
                          </span>
                        )}
                        <span className="ml-auto shrink-0 font-mono text-[11px] text-muted">
                          {m.sizeMB} MB
                        </span>
                      </div>
                      <div className="mt-1 pl-[26px]">
                        <div className="font-mono text-[11px] text-muted">{m.name}</div>
                        <div
                          className={`mt-0.5 text-[11.5px] ${
                            st?.kind === "err"
                              ? "text-err"
                              : st?.kind === "ok"
                                ? "text-accent-ink"
                                : "text-muted"
                          }`}
                        >
                          {prog
                            ? prog.label
                            : `${st?.text ?? "未加载"}${
                                m.sizeMB >= 100 && (!st || st.kind === "")
                                  ? " · 首次加载较慢"
                                  : ""
                              }`}
                        </div>
                        {m.sizeMB >= 100 && (
                          <div className="mt-1 text-[11px] text-muted lg:hidden">
                            移动网络下载耗时长、内存占用高
                          </div>
                        )}
                        {prog && (
                          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-border">
                            {prog.pct === null ? (
                              <div className="h-full w-full animate-pulse rounded-full bg-accent" />
                            ) : (
                              <div
                                className="h-full rounded-full bg-accent transition-[width] duration-150"
                                style={{ width: `${prog.pct}%` }}
                              />
                            )}
                          </div>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>

              <p aria-live="polite" className="text-[11.5px] leading-relaxed text-muted">
                {statusText}
              </p>

              {results && results.length > 0 && (
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => void copyAll()}
                    className={`${secondaryBtn} flex-1 ${
                      copyState === "err" ? "border-err text-err" : ""
                    }`}
                  >
                    {copyState === "ok"
                      ? "已复制"
                      : copyState === "err"
                        ? "复制失败"
                        : "复制全文"}
                  </button>
                  <button
                    type="button"
                    onClick={downloadTxt}
                    className={`${secondaryBtn} flex-1`}
                  >
                    下载 .txt
                  </button>
                </div>
              )}

              {/* 底部固定操作 */}
              <div className="mt-auto flex flex-col gap-2 border-t border-border pt-4">
                <button
                  type="button"
                  onClick={() => void runOCR()}
                  disabled={!ready || running}
                  className={primaryBtn}
                >
                  {runLabel}
                </button>
                <button
                  type="button"
                  onClick={clearImage}
                  disabled={running}
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
