import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { createImageCanvas, supportsOcrCanvas } from "../src/image-canvas.ts";

const originalCanvas = globalThis.OffscreenCanvas;
const originalImage = globalThis.ImageData;
afterEach(() => {
  if (originalCanvas === undefined) delete globalThis.OffscreenCanvas; else globalThis.OffscreenCanvas = originalCanvas;
  if (originalImage === undefined) delete globalThis.ImageData; else globalThis.ImageData = originalImage;
});
it("creates a 2D canvas in a Worker-like environment without document", () => {
  assert.equal(typeof document, "undefined");
  globalThis.ImageData = class {};
  globalThis.OffscreenCanvas = class {
    constructor(width, height) { this.width = width; this.height = height; }
    getContext(kind) { return kind === "2d" ? {} : null; }
  };
  assert.ok(supportsOcrCanvas());
  const canvas = createImageCanvas(32, 64);
  assert.equal(canvas.width, 32); assert.equal(canvas.height, 64);
});
it("fails clearly when the environment cannot supply Worker canvas APIs", () => {
  delete globalThis.OffscreenCanvas;
  assert.equal(supportsOcrCanvas(), false);
  assert.throws(() => createImageCanvas(32, 64), /OffscreenCanvas/);
});
