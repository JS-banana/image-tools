// 后处理：1024² 有限 alpha → 容差 clamp → 双线性回源尺寸 Uint8ClampedArray。

import {
  ALPHA_RANGE_EPS,
  BEN2_INPUT_SIZE,
  InvalidAlphaError,
  InvalidImageError,
} from "./types.ts";

function clampCoord(v: number, max: number): number {
  if (v < 0) return 0;
  if (v > max) return max;
  return v;
}

function clampUnit(v: number): number {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function assertSourceSize(width: number, height: number): void {
  if (
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new InvalidImageError(`非法回采样尺寸: ${String(width)}x${String(height)}`);
  }
}

function sanitizeAlphas(alphas: ArrayLike<number>): void {
  const expected = BEN2_INPUT_SIZE * BEN2_INPUT_SIZE;
  if (alphas == null || typeof alphas.length !== "number") {
    throw new InvalidAlphaError("缺少 alpha 缓冲");
  }
  if (alphas.length !== expected) {
    throw new InvalidAlphaError(
      `alpha 长度必须是 ${expected}（1024²），实际 ${alphas.length}`,
    );
  }
  const lo = -ALPHA_RANGE_EPS;
  const hi = 1 + ALPHA_RANGE_EPS;
  for (let i = 0; i < expected; i++) {
    const v = alphas[i];
    if (!Number.isFinite(v)) {
      throw new InvalidAlphaError(`alpha 含非有限值（index=${i}）`);
    }
    if (v < lo || v > hi) {
      throw new InvalidAlphaError(
        `alpha 超出 [0, 1] 容差: index=${i}, value=${v}`,
      );
    }
  }
}

function quantize(v: number): number {
  return Math.round(clampUnit(v) * 255);
}

/**
 * 先扫描全部 1024² 有限值并按 1e-6 容差拒绝越界，再双线性回源尺寸。
 * 不允许把 NaN 交给 Uint8ClampedArray（其会静默变成 0）。
 */
export function postprocess(
  alphas: ArrayLike<number>,
  width: number,
  height: number,
): Uint8ClampedArray<ArrayBuffer> {
  assertSourceSize(width, height);
  sanitizeAlphas(alphas);

  const size = BEN2_INPUT_SIZE;
  if (width === size && height === size) {
    const out = new Uint8ClampedArray(size * size);
    for (let i = 0; i < out.length; i++) out[i] = quantize(alphas[i]);
    return out;
  }

  const out = new Uint8ClampedArray(width * height);
  const x0s = new Uint16Array(width);
  const x1s = new Uint16Array(width);
  const xWeights = new Float32Array(width);
  const xMax = size - 1;
  const scaleX = size / width;
  for (let x = 0; x < width; x++) {
    const sx = clampCoord((x + 0.5) * scaleX - 0.5, xMax);
    const x0 = Math.floor(sx);
    x0s[x] = x0;
    x1s[x] = x0 >= xMax ? xMax : x0 + 1;
    xWeights[x] = sx - x0;
  }

  const yMax = size - 1;
  const scaleY = size / height;
  for (let y = 0; y < height; y++) {
    const sy = clampCoord((y + 0.5) * scaleY - 0.5, yMax);
    const y0 = Math.floor(sy);
    const y1 = y0 >= yMax ? yMax : y0 + 1;
    const fy = sy - y0;
    const row0 = y0 * size;
    const row1 = y1 * size;
    const destRow = y * width;

    for (let x = 0; x < width; x++) {
      const x0 = x0s[x];
      const x1 = x1s[x];
      const fx = xWeights[x];
      const v00 = alphas[row0 + x0];
      const v10 = alphas[row0 + x1];
      const v01 = alphas[row1 + x0];
      const v11 = alphas[row1 + x1];
      const v0 = v00 + (v10 - v00) * fx;
      const v1 = v01 + (v11 - v01) * fx;
      let value = v0 + (v1 - v0) * fy;
      if (value < 0) value = 0;
      else if (value > 1) value = 1;
      out[destRow + x] = Math.round(value * 255);
    }
  }
  return out;
}
