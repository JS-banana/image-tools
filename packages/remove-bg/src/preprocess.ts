// 预处理：ImageData-like → 1024² CHW Float32Array（RGB ImageNet）。无中间 Canvas。

import {
  BEN2_INPUT_SIZE,
  IMAGENET_MEAN,
  IMAGENET_STD,
  assertImageData,
  type ImageDataLike,
} from "./types.ts";

function clampCoord(v: number, max: number): number {
  if (v < 0) return 0;
  if (v > max) return max;
  return v;
}

/**
 * 双线性采样到 1024×1024，按 RGB ImageNet mean/std 写成 NCHW 布局的 Float32Array。
 * 源 alpha 不参与模型输入；全透明像素保留其 RGB。
 */
export function preprocess(image: ImageDataLike): Float32Array {
  const { data, width, height } = assertImageData(image);
  const size = BEN2_INPUT_SIZE;
  const plane = size * size;
  const out = new Float32Array(3 * plane);
  const x0Offsets = new Uint32Array(size);
  const x1Offsets = new Uint32Array(size);
  const xWeights = new Float32Array(size);
  const xMax = width - 1;
  const scaleX = width / size;

  for (let x = 0; x < size; x++) {
    const sx = clampCoord((x + 0.5) * scaleX - 0.5, xMax);
    const x0 = Math.floor(sx);
    const x1 = x0 >= xMax ? xMax : x0 + 1;
    x0Offsets[x] = x0 * 4;
    x1Offsets[x] = x1 * 4;
    xWeights[x] = sx - x0;
  }

  const yMax = height - 1;
  const scaleY = height / size;
  for (let y = 0; y < size; y++) {
    const sy = clampCoord((y + 0.5) * scaleY - 0.5, yMax);
    const y0 = Math.floor(sy);
    const y1 = y0 >= yMax ? yMax : y0 + 1;
    const fy = sy - y0;
    const row0 = y0 * width * 4;
    const row1 = y1 * width * 4;
    const destRow = y * size;

    for (let x = 0; x < size; x++) {
      const i00 = row0 + x0Offsets[x];
      const i10 = row0 + x1Offsets[x];
      const i01 = row1 + x0Offsets[x];
      const i11 = row1 + x1Offsets[x];
      const fx = xWeights[x];
      const di = destRow + x;

      const r0 = data[i00] + (data[i10] - data[i00]) * fx;
      const r1 = data[i01] + (data[i11] - data[i01]) * fx;
      const g0 = data[i00 + 1] + (data[i10 + 1] - data[i00 + 1]) * fx;
      const g1 = data[i01 + 1] + (data[i11 + 1] - data[i01 + 1]) * fx;
      const b0 = data[i00 + 2] + (data[i10 + 2] - data[i00 + 2]) * fx;
      const b1 = data[i01 + 2] + (data[i11 + 2] - data[i01 + 2]) * fx;

      out[di] = ((r0 + (r1 - r0) * fy) / 255 - IMAGENET_MEAN[0]) / IMAGENET_STD[0];
      out[plane + di] =
        ((g0 + (g1 - g0) * fy) / 255 - IMAGENET_MEAN[1]) / IMAGENET_STD[1];
      out[2 * plane + di] =
        ((b0 + (b1 - b0) * fy) / 255 - IMAGENET_MEAN[2]) / IMAGENET_STD[2];
    }
  }
  return out;
}
