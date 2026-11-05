import type { ImageDecodePolicy } from "../../shared/browser-image/decode.ts";

// Keep the existing removal input budget and output size policy.
export const REMOVE_BG_IMAGE_POLICY: ImageDecodePolicy = {
  maxFileBytes: 50 * 1024 * 1024,
  maxSourcePixels: 4096 * 4096,
  maxOutputSide: 4096,
};
