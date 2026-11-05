import type { ImageDecodePolicy } from "../../shared/browser-image/decode.ts";

// Preserve source resolution for small text and long screenshots. Bound source
// allocation independently of the model's detector resize.
export const OCR_IMAGE_POLICY: ImageDecodePolicy = {
  maxFileBytes: 50 * 1024 * 1024,
  maxSourcePixels: 32 * 1024 * 1024,
  maxOutputSide: null,
};
