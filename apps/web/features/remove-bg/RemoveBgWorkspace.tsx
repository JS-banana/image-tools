"use client";

import { SiteHeader } from "@/components/site-header";
import { RemoveBgPreview } from "./RemoveBgPreview";
import { useRemoveBgController } from "./use-remove-bg-controller";
import { BG_CHOICES, backendLabel, formatMiB, formatMs } from "./presentation";

const primaryBtn =
  "min-h-11 rounded-[8px] bg-accent px-4 py-2.5 text-[13px] font-medium text-[#171717] transition-[opacity,scale] duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-ink enabled:[@media(hover:hover)]:hover:opacity-90 enabled:active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40";
const secondaryBtn =
  "min-h-11 rounded-[8px] border border-border bg-panel px-4 py-2.5 text-[13px] font-medium text-text transition-[border-color,scale] duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-ink enabled:[@media(hover:hover)]:hover:border-accent/70 enabled:active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40";


export default function RemoveBgWorkspace() {
  const {
    image, alpha, hasImage, hasResult, imageError, imageSize, scaledNote,
    status, runMeta, bgChoice, setBgChoice, customHex, setCustomHex,
    view, setView, showSource, busy, displayBackend, downloadError,
    fileInputRef, openFilePicker, dropHandlers, dragOver, loadImageFile,
    clearImage, confirmWasm, retry, downloadPng, onHoldPointerDown, onHoldPointerUp,
  } = useRemoveBgController();

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
              {image && (
                <RemoveBgPreview
                  source={image}
                  alpha={alpha}
                  bgChoice={bgChoice}
                  customHex={customHex}
                  showSource={showSource}
                  dragOver={dragOver}
                  onPointerDown={onHoldPointerDown}
                  onPointerUp={onHoldPointerUp}
                />
              )}
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
