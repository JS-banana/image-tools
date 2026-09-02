// 合成：透明保留源 RGB+matte；纯色逐通道 round(src*a+bg*(1-a)) 且 A=255。

import {
  InvalidComposeError,
  assertImageData,
  type ComposeBackground,
  type ImageDataLike,
} from "./types.ts";

function assertByte(n: unknown, label: string): number {
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 255) {
    throw new InvalidComposeError(`${label} 必须是 0–255 整数`);
  }
  return n;
}

function assertMatte(matte: ArrayLike<number>, pixelCount: number): void {
  if (matte == null || typeof matte.length !== "number") {
    throw new InvalidComposeError("缺少 matte 缓冲");
  }
  if (matte.length !== pixelCount) {
    throw new InvalidComposeError(
      `matte 长度 ${matte.length} 与图像像素数 ${pixelCount} 不匹配`,
    );
  }
  for (let i = 0; i < pixelCount; i++) {
    const a = matte[i];
    if (!Number.isFinite(a) || a < 0 || a > 255) {
      throw new InvalidComposeError(`matte 含非法值（index=${i}, value=${String(a)}）`);
    }
  }
}

function assertSolid(background: ComposeBackground): readonly [number, number, number] {
  if (!Array.isArray(background) || background.length !== 3) {
    throw new InvalidComposeError("纯色背景必须是长度为 3 的 [r,g,b]");
  }
  return [
    assertByte(background[0], "R"),
    assertByte(background[1], "G"),
    assertByte(background[2], "B"),
  ];
}

/**
 * 源与 matte 必须同尺寸；返回 RGBA 紧凑缓冲（长度 width*height*4）。
 */
export function compose(
  source: ImageDataLike,
  matte: ArrayLike<number>,
  background: ComposeBackground,
): Uint8ClampedArray<ArrayBuffer> {
  const { data, width, height } = assertImageData(source);
  const pixelCount = width * height;
  assertMatte(matte, pixelCount);
  const out = new Uint8ClampedArray(pixelCount * 4);

  if (background === "transparent") {
    for (let i = 0; i < pixelCount; i++) {
      const si = i * 4;
      out[si] = data[si];
      out[si + 1] = data[si + 1];
      out[si + 2] = data[si + 2];
      out[si + 3] = matte[i];
    }
    return out;
  }

  const [br, bg, bb] = assertSolid(background);
  for (let i = 0; i < pixelCount; i++) {
    const si = i * 4;
    const a = matte[i] / 255;
    const ia = 1 - a;
    out[si] = Math.round(data[si] * a + br * ia);
    out[si + 1] = Math.round(data[si + 1] * a + bg * ia);
    out[si + 2] = Math.round(data[si + 2] * a + bb * ia);
    out[si + 3] = 255;
  }
  return out;
}
