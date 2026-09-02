import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_SOURCE_PIXELS,
  planImageDecode,
  readRasterMetadata,
} from "../lib/remove-bg-image.ts";

function concat(...parts) {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function ascii(value) {
  return Uint8Array.from(value, (char) => char.charCodeAt(0));
}

function be16(value) {
  return Uint8Array.of((value >>> 8) & 255, value & 255);
}

function be32(value) {
  return Uint8Array.of(
    (value >>> 24) & 255,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255,
  );
}

function le32(value) {
  return Uint8Array.of(
    value & 255,
    (value >>> 8) & 255,
    (value >>> 16) & 255,
    (value >>> 24) & 255,
  );
}

function exif(orientation) {
  return Uint8Array.of(
    0x45, 0x78, 0x69, 0x66, 0, 0,
    0x49, 0x49, 0x2a, 0, 8, 0, 0, 0,
    1, 0,
    0x12, 0x01, 3, 0, 1, 0, 0, 0, orientation, 0, 0, 0,
    0, 0, 0, 0,
  );
}

function jpeg(width, height, orientation = 1) {
  const app1 = exif(orientation);
  const sof = concat(
    Uint8Array.of(8),
    be16(height),
    be16(width),
    Uint8Array.of(1, 1, 0x11, 0),
  );
  return concat(
    Uint8Array.of(0xff, 0xd8, 0xff, 0xe1),
    be16(app1.length + 2),
    app1,
    Uint8Array.of(0xff, 0xc0),
    be16(sof.length + 2),
    sof,
    Uint8Array.of(0xff, 0xda),
  );
}

function pngChunk(type, data) {
  return concat(be32(data.length), ascii(type), data, Uint8Array.of(0, 0, 0, 0));
}

function png(width, height, orientation = 1) {
  const ihdr = concat(be32(width), be32(height), Uint8Array.of(8, 6, 0, 0, 0));
  return concat(
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    pngChunk("IHDR", ihdr),
    ...(orientation === 1 ? [] : [pngChunk("eXIf", exif(orientation).slice(6))]),
    pngChunk("IDAT", new Uint8Array()),
  );
}

function webpChunk(type, data) {
  return concat(
    ascii(type),
    le32(data.length),
    data,
    ...(data.length & 1 ? [Uint8Array.of(0)] : []),
  );
}

function webp(...chunks) {
  const body = concat(ascii("WEBP"), ...chunks);
  return concat(ascii("RIFF"), le32(body.length), body);
}

function vp8x(width, height, withExif = false) {
  const data = new Uint8Array(10);
  if (withExif) data[0] = 0x08;
  const w = width - 1;
  const h = height - 1;
  data.set([w & 255, (w >>> 8) & 255, (w >>> 16) & 255], 4);
  data.set([h & 255, (h >>> 8) & 255, (h >>> 16) & 255], 7);
  return webpChunk("VP8X", data);
}

function vp8(width, height) {
  return webpChunk(
    "VP8 ",
    Uint8Array.of(
      0, 0, 0,
      0x9d, 0x01, 0x2a,
      width & 255, (width >>> 8) & 0x3f,
      height & 255, (height >>> 8) & 0x3f,
    ),
  );
}

function vp8l(width, height) {
  const bits = ((width - 1) | ((height - 1) << 14)) >>> 0;
  return webpChunk("VP8L", concat(Uint8Array.of(0x2f), le32(bits)));
}

describe("readRasterMetadata", () => {
  it("reads PNG IHDR dimensions", async () => {
    const metadata = await readRasterMetadata(new Blob([png(4032, 3024)]));
    assert.deepEqual(metadata, {
      type: "png",
      width: 4032,
      height: 3024,
      orientation: 1,
      displayWidth: 4032,
      displayHeight: 3024,
    });
  });

  it("applies JPEG EXIF axis rotation before planning resize", async () => {
    const metadata = await readRasterMetadata(new Blob([jpeg(6000, 2000, 6)]));
    assert.equal(metadata.displayWidth, 2000);
    assert.equal(metadata.displayHeight, 6000);
    assert.deepEqual(planImageDecode(metadata), {
      metadata,
      width: 1365,
      height: 4096,
      scaled: true,
    });
  });

  it("reads WebP VP8X dimensions and EXIF orientation", async () => {
    const metadata = await readRasterMetadata(
      new Blob([webp(vp8x(8000, 2000, true), webpChunk("EXIF", exif(8)))]),
    );
    assert.equal(metadata.type, "webp");
    assert.equal(metadata.orientation, 8);
    assert.equal(metadata.displayWidth, 2000);
    assert.equal(metadata.displayHeight, 8000);
    assert.equal(planImageDecode(metadata).width, 1024);
    assert.equal(planImageDecode(metadata).height, 4096);
  });

  it("reads WebP VP8 and VP8L dimensions", async () => {
    const lossy = await readRasterMetadata(new Blob([webp(vp8(640, 480))]));
    const lossless = await readRasterMetadata(new Blob([webp(vp8l(321, 123))]));
    assert.deepEqual([lossy.width, lossy.height], [640, 480]);
    assert.deepEqual([lossless.width, lossless.height], [321, 123]);
  });

  it("rejects sources above the fixed pixel budget", async () => {
    const metadata = await readRasterMetadata(new Blob([png(5000, 4000)]));
    assert.equal(MAX_SOURCE_PIXELS, 16_777_216);
    assert.throws(() => planImageDecode(metadata), /16,777,216/);

    const conflictingWebp = await readRasterMetadata(
      new Blob([webp(vp8x(100, 100), vp8(5000, 4000))]),
    );
    assert.deepEqual([conflictingWebp.width, conflictingWebp.height], [5000, 4000]);
    assert.throws(() => planImageDecode(conflictingWebp), /16,777,216/);
  });

  it("rejects unsupported or malformed input before decode", async () => {
    await assert.rejects(
      readRasterMetadata(new Blob([ascii("not an image")])),
      /不支持的文件格式/,
    );
    await assert.rejects(
      readRasterMetadata(new Blob([Uint8Array.of(0xff, 0xd8, 0xff)])),
      /图片解码失败/,
    );
  });
});
