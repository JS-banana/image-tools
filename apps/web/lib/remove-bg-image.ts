// 去背景输入边界：解码前读取 JPG / PNG / WebP 尺寸与方向，限制像素峰值。
// 头部解析只读取小段 Blob，Node 可测；decodeImageFile 仅由客户端调用。

export const MAX_IMAGE_SIDE = 4096;
export const MAX_IMAGE_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_SOURCE_PIXELS = MAX_IMAGE_SIDE * MAX_IMAGE_SIDE;

const MAX_METADATA_CHUNKS = 1024;
const MAX_EXIF_BYTES = 1024 * 1024;
const DECODE_ERROR = "图片解码失败，请换一张图片";

export type RasterImageType = "jpeg" | "png" | "webp";

export interface RasterMetadata {
  type: RasterImageType;
  width: number;
  height: number;
  orientation: number;
  displayWidth: number;
  displayHeight: number;
}

export interface ImageDecodePlan {
  metadata: RasterMetadata;
  width: number;
  height: number;
  scaled: boolean;
}

export interface DecodedImage {
  imageData: ImageData;
  scaled: boolean;
}

class ImageInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageInputError";
  }
}

function fail(message: string): never {
  throw new ImageInputError(message);
}

function hasRange(total: number, offset: number, length: number): boolean {
  return (
    Number.isSafeInteger(offset) &&
    Number.isSafeInteger(length) &&
    offset >= 0 &&
    length >= 0 &&
    offset <= total - length
  );
}

async function readRange(blob: Blob, offset: number, length: number): Promise<Uint8Array> {
  if (!hasRange(blob.size, offset, length)) fail(DECODE_ERROR);
  return new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (!hasRange(bytes.length, offset, length)) return "";
  let out = "";
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i]);
  return out;
}

function u16be(bytes: Uint8Array, offset: number): number {
  if (!hasRange(bytes.length, offset, 2)) fail(DECODE_ERROR);
  return bytes[offset] * 0x100 + bytes[offset + 1];
}

function u24le(bytes: Uint8Array, offset: number): number {
  if (!hasRange(bytes.length, offset, 3)) fail(DECODE_ERROR);
  return bytes[offset] + bytes[offset + 1] * 0x100 + bytes[offset + 2] * 0x10000;
}

function u32be(bytes: Uint8Array, offset: number): number {
  if (!hasRange(bytes.length, offset, 4)) fail(DECODE_ERROR);
  return (
    bytes[offset] * 0x1000000 +
    bytes[offset + 1] * 0x10000 +
    bytes[offset + 2] * 0x100 +
    bytes[offset + 3]
  );
}

function u32le(bytes: Uint8Array, offset: number): number {
  if (!hasRange(bytes.length, offset, 4)) fail(DECODE_ERROR);
  return (
    bytes[offset] +
    bytes[offset + 1] * 0x100 +
    bytes[offset + 2] * 0x10000 +
    bytes[offset + 3] * 0x1000000
  );
}

function parseExifOrientation(payload: Uint8Array): number {
  let tiff = 0;
  if (ascii(payload, 0, 6) === "Exif\u0000\u0000") tiff = 6;
  if (!hasRange(payload.length, tiff, 8)) return 1;

  const order = ascii(payload, tiff, 2);
  const little = order === "II";
  if (!little && order !== "MM") return 1;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const get16 = (offset: number): number | null =>
    hasRange(payload.length, offset, 2) ? view.getUint16(offset, little) : null;
  const get32 = (offset: number): number | null =>
    hasRange(payload.length, offset, 4) ? view.getUint32(offset, little) : null;

  if (get16(tiff + 2) !== 42) return 1;
  const relativeIfd = get32(tiff + 4);
  if (relativeIfd === null) return 1;
  const ifd = tiff + relativeIfd;
  const count = get16(ifd);
  if (count === null || count > 4096) return 1;

  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (!hasRange(payload.length, entry, 12)) return 1;
    if (get16(entry) !== 0x0112) continue;
    if (get16(entry + 2) !== 3 || get32(entry + 4) !== 1) return 1;
    const orientation = get16(entry + 8);
    return orientation !== null && orientation >= 1 && orientation <= 8
      ? orientation
      : 1;
  }
  return 1;
}

function makeMetadata(
  type: RasterImageType,
  width: number,
  height: number,
  orientation: number,
): RasterMetadata {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    fail(DECODE_ERROR);
  }
  const swapsAxes = orientation >= 5 && orientation <= 8;
  return {
    type,
    width,
    height,
    orientation,
    displayWidth: swapsAxes ? height : width,
    displayHeight: swapsAxes ? width : height,
  };
}

function isJpegSof(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

async function readJpegMetadata(blob: Blob): Promise<RasterMetadata> {
  let offset = 2;
  let width = 0;
  let height = 0;
  let orientation = 1;

  for (let chunk = 0; chunk < MAX_METADATA_CHUNKS && offset < blob.size; chunk++) {
    let markerBytes = await readRange(blob, offset, Math.min(2, blob.size - offset));
    if (markerBytes.length < 2 || markerBytes[0] !== 0xff) fail(DECODE_ERROR);
    while (markerBytes[1] === 0xff) {
      offset += 1;
      markerBytes = await readRange(blob, offset, Math.min(2, blob.size - offset));
      if (markerBytes.length < 2 || markerBytes[0] !== 0xff) fail(DECODE_ERROR);
    }
    const marker = markerBytes[1];
    offset += 2;

    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;

    const lengthBytes = await readRange(blob, offset, 2);
    const segmentLength = u16be(lengthBytes, 0);
    if (segmentLength < 2 || !hasRange(blob.size, offset, segmentLength)) {
      fail(DECODE_ERROR);
    }
    const payloadOffset = offset + 2;
    const payloadLength = segmentLength - 2;

    if (marker === 0xe1 && payloadLength >= 6) {
      const prefix = await readRange(blob, payloadOffset, 6);
      if (ascii(prefix, 0, 6) === "Exif\u0000\u0000") {
        const exif = await readRange(blob, payloadOffset, payloadLength);
        orientation = parseExifOrientation(exif);
      }
    } else if (isJpegSof(marker)) {
      if (payloadLength < 5 || width || height) fail(DECODE_ERROR);
      const sof = await readRange(blob, payloadOffset, 5);
      height = u16be(sof, 1);
      width = u16be(sof, 3);
    }
    offset += segmentLength;
  }

  if (!width || !height) fail(DECODE_ERROR);
  return makeMetadata("jpeg", width, height, orientation);
}

async function readPngMetadata(blob: Blob): Promise<RasterMetadata> {
  let offset = 8;
  let width = 0;
  let height = 0;
  let orientation = 1;

  for (let chunk = 0; chunk < MAX_METADATA_CHUNKS && offset < blob.size; chunk++) {
    const header = await readRange(blob, offset, 8);
    const length = u32be(header, 0);
    const type = ascii(header, 4, 4);
    const dataOffset = offset + 8;
    const next = dataOffset + length + 4;
    if (!Number.isSafeInteger(next) || next > blob.size) fail(DECODE_ERROR);

    if (type === "IHDR") {
      if (offset !== 8 || length !== 13) fail(DECODE_ERROR);
      const ihdr = await readRange(blob, dataOffset, 8);
      width = u32be(ihdr, 0);
      height = u32be(ihdr, 4);
    } else if (type === "eXIf") {
      if (length > MAX_EXIF_BYTES) fail("图片方向元数据过大，请先重新导出图片");
      orientation = parseExifOrientation(await readRange(blob, dataOffset, length));
    } else if (type === "IDAT" || type === "IEND") {
      break;
    }
    offset = next;
  }

  if (!width || !height) fail(DECODE_ERROR);
  return makeMetadata("png", width, height, orientation);
}

async function readWebpMetadata(blob: Blob): Promise<RasterMetadata> {
  const riff = await readRange(blob, 0, 12);
  const declaredEnd = u32le(riff, 4) + 8;
  if (!Number.isSafeInteger(declaredEnd) || declaredEnd > blob.size) fail(DECODE_ERROR);

  let offset = 12;
  let width = 0;
  let height = 0;
  let orientation = 1;
  let expectsExif = false;
  let foundExif = false;

  for (let chunk = 0; chunk < MAX_METADATA_CHUNKS && offset + 8 <= declaredEnd; chunk++) {
    const header = await readRange(blob, offset, 8);
    const type = ascii(header, 0, 4);
    const length = u32le(header, 4);
    const dataOffset = offset + 8;
    const paddedLength = length + (length & 1);
    const next = dataOffset + paddedLength;
    if (!Number.isSafeInteger(next) || next > declaredEnd) fail(DECODE_ERROR);

    if (type === "VP8X") {
      if (length < 10) fail(DECODE_ERROR);
      const vp8x = await readRange(blob, dataOffset, 10);
      expectsExif = (vp8x[0] & 0x08) !== 0;
      width = Math.max(width, u24le(vp8x, 4) + 1);
      height = Math.max(height, u24le(vp8x, 7) + 1);
    } else if (type === "VP8 ") {
      if (length < 10) fail(DECODE_ERROR);
      const vp8 = await readRange(blob, dataOffset, 10);
      if (vp8[3] !== 0x9d || vp8[4] !== 0x01 || vp8[5] !== 0x2a) fail(DECODE_ERROR);
      width = Math.max(width, (vp8[6] | (vp8[7] << 8)) & 0x3fff);
      height = Math.max(height, (vp8[8] | (vp8[9] << 8)) & 0x3fff);
    } else if (type === "VP8L") {
      if (length < 5) fail(DECODE_ERROR);
      const vp8l = await readRange(blob, dataOffset, 5);
      if (vp8l[0] !== 0x2f) fail(DECODE_ERROR);
      const bits = u32le(vp8l, 1);
      width = Math.max(width, (bits & 0x3fff) + 1);
      height = Math.max(height, ((bits >>> 14) & 0x3fff) + 1);
    } else if (type === "EXIF") {
      if (length > MAX_EXIF_BYTES) fail("图片方向元数据过大，请先重新导出图片");
      orientation = parseExifOrientation(await readRange(blob, dataOffset, length));
      foundExif = true;
    }
    offset = next;
  }

  if (!width || !height || (expectsExif && !foundExif)) fail(DECODE_ERROR);
  return makeMetadata("webp", width, height, orientation);
}

export async function readRasterMetadata(blob: Blob): Promise<RasterMetadata> {
  if (!(blob instanceof Blob) || blob.size === 0) fail("文件为空，请重新选择图片");
  const signature = await readRange(blob, 0, Math.min(12, blob.size));
  if (signature.length >= 2 && signature[0] === 0xff && signature[1] === 0xd8) {
    return readJpegMetadata(blob);
  }
  if (
    signature.length >= 8 &&
    signature[0] === 0x89 &&
    ascii(signature, 1, 3) === "PNG" &&
    signature[4] === 0x0d &&
    signature[5] === 0x0a &&
    signature[6] === 0x1a &&
    signature[7] === 0x0a
  ) {
    return readPngMetadata(blob);
  }
  if (
    signature.length >= 12 &&
    ascii(signature, 0, 4) === "RIFF" &&
    ascii(signature, 8, 4) === "WEBP"
  ) {
    return readWebpMetadata(blob);
  }
  fail("不支持的文件格式，请选择 JPG、PNG 或 WebP 图片");
}

export function planImageDecode(metadata: RasterMetadata): ImageDecodePlan {
  if (metadata.width > Math.floor(MAX_SOURCE_PIXELS / metadata.height)) {
    fail("图片像素超过 16,777,216（4096²），请先缩小图片后再试");
  }
  const longest = Math.max(metadata.displayWidth, metadata.displayHeight);
  const scale = longest > MAX_IMAGE_SIDE ? MAX_IMAGE_SIDE / longest : 1;
  return {
    metadata,
    width: Math.max(1, Math.round(metadata.displayWidth * scale)),
    height: Math.max(1, Math.round(metadata.displayHeight * scale)),
    scaled: scale < 1,
  };
}

function rasterizeToImageData(
  source: CanvasImageSource,
  width: number,
  height: number,
): ImageData {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  try {
    const ctx = canvas.getContext("2d");
    if (!ctx) fail(DECODE_ERROR);
    ctx.drawImage(source, 0, 0, width, height);
    return ctx.getImageData(0, 0, width, height);
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

export async function decodeImageFile(file: File): Promise<DecodedImage> {
  if (file.size > MAX_IMAGE_FILE_BYTES) {
    fail("文件超过 50 MB，请先缩小图片后再试");
  }
  try {
    const plan = planImageDecode(await readRasterMetadata(file));
    if (typeof createImageBitmap === "function") {
      const bitmap = await createImageBitmap(file, {
        imageOrientation: "from-image",
        resizeWidth: plan.width,
        resizeHeight: plan.height,
        resizeQuality: "high",
      });
      try {
        if (bitmap.width !== plan.width || bitmap.height !== plan.height) {
          fail(DECODE_ERROR);
        }
        return {
          imageData: rasterizeToImageData(bitmap, plan.width, plan.height),
          scaled: plan.scaled,
        };
      } finally {
        bitmap.close();
      }
    }

    const url = URL.createObjectURL(file);
    try {
      const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const element = new Image();
        element.onload = () => resolve(element);
        element.onerror = () => reject(new Error(DECODE_ERROR));
        element.src = url;
      });
      if (
        image.naturalWidth !== plan.metadata.displayWidth ||
        image.naturalHeight !== plan.metadata.displayHeight
      ) {
        fail(DECODE_ERROR);
      }
      return {
        imageData: rasterizeToImageData(image, plan.width, plan.height),
        scaled: plan.scaled,
      };
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch (error) {
    if (error instanceof ImageInputError) throw error;
    throw new ImageInputError(DECODE_ERROR);
  }
}
