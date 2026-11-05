/** The same Canvas 2D resampling API in a dedicated Worker or on the main thread. */
export function supportsOcrCanvas(): boolean {
  return typeof globalThis.OffscreenCanvas === "function" && typeof globalThis.ImageData === "function";
}

export function createImageCanvas(width: number, height: number): OffscreenCanvas {
  if (!supportsOcrCanvas()) {
    throw new Error("OCR 需要支持 OffscreenCanvas 和 ImageData 的浏览器");
  }
  const canvas = new OffscreenCanvas(width, height);
  if (!canvas.getContext("2d")) throw new Error("无法创建 OCR Canvas 2D 上下文");
  return canvas;
}
