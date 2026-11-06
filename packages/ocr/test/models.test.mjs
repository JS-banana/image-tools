import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { describe, it } from "node:test";
import { ManifestError, toModelSummary } from "@img/model-runtime";
import { isPpocrModelEntry, parseOcrCatalog } from "../src/models.ts";

const fixture = () => JSON.parse(readFileSync(new URL("../models.json", import.meta.url), "utf8"));

describe("OCR model catalog", () => {
  it("validates the three source models with original numeric contracts", () => {
    const { models } = parseOcrCatalog(fixture());
    assert.deepEqual(models.map((m) => m.id), ["ppocrv6-tiny", "ppocrv6-small", "ppocrv6-medium"]);
    assert.ok(models.every(isPpocrModelEntry));
    assert.equal(isPpocrModelEntry({ pipeline: "another" }), false);
    for (const [i, model] of models.entries()) {
      assert.equal(model.recommended, i === 0);
      assert.equal(model.params.colorOrder, "BGR");
      assert.equal(model.params.dictSize, i === 0 ? 6906 : 18710);
      assert.equal(model.params.boxThresh, i === 0 ? 0.4 : 0.45);
      assert.equal(model.files.dict.url, `/models/${model.id}/dict.json`);
      for (const [role, file] of Object.entries(model.files)) {
        assert.equal(file.sha256, fixture().models[i].files[role].sha256);
      }
      assert.equal(toModelSummary(model).downloadBytes, Object.values(model.files).reduce((sum, f) => sum + f.sizeBytes, 0));
    }
  });
  it("accepts a Tiny-only deployment catalog", () => {
    const raw = fixture(); raw.models = raw.models.slice(0, 1);
    assert.equal(parseOcrCatalog(raw).models.length, 1);
  });
  it("owns its pipeline and rejects unrelated models", () => {
    const raw = fixture(); raw.models[0].pipeline = "ben2-background-removal";
    assert.throws(() => parseOcrCatalog(raw), /未知 pipeline/);
  });
  it("rejects missing fields with model id and exact parameter path", () => {
    const raw = fixture(); delete raw.models[0].params.boxThresh;
    assert.throws(() => parseOcrCatalog(raw), (error) => error instanceof ManifestError && /ppocrv6-tiny.*params\.boxThresh/.test(error.message));
  });
  it("enforces files and parameter invariants", () => {
    for (const change of [
      (m) => { m.files.det = "models/a.onnx"; },
      (m) => { delete m.files.dict; },
      (m) => { m.files.extra = m.files.det; },
      (m) => { m.params.colorOrder = "RGB"; },
      ...["detMaxSide", "recHeight", "recMaxWidth", "dictSize", "minBoxSide"].map((key) => (m) => { m.params[key] = 48.5; }),
      (m) => { m.params.recMaxWidth = m.params.recHeight - 1; },
      (m) => { m.params.detThresh = 2; },
      (m) => { m.params.boxThresh = -1; },
      (m) => { m.params.unclipRatio = 0; },
    ]) {
      const raw = fixture(); change(raw.models[0]);
      assert.throws(() => parseOcrCatalog(raw), ManifestError);
    }
  });
  it("rejects unsafe asset paths, invalid sizes, duplicate ids and invalid recommendations", () => {
    for (const url of ["/\\evil.example/model.onnx", "https://evil.example/model.onnx", "//evil.example/model.onnx", "/models/x.onnx?x=1", "/models/x.onnx#frag", "/models/../secret", "/ort/ort.wasm", "models/x.onnx"]) {
      const raw = fixture(); raw.models[0].files.det.url = url;
      assert.throws(() => parseOcrCatalog(raw), /files\.det\.url/, url);
    }
    for (const change of [
      (raw) => { raw.models[0].files.det.sizeBytes = 0; },
      (raw) => { raw.models[1].id = raw.models[0].id; },
      (raw) => { raw.models[0].recommended = false; },
      (raw) => { raw.models[1].recommended = true; },
    ]) { const raw = fixture(); change(raw); assert.throws(() => parseOcrCatalog(raw), ManifestError); }
  });
  it("checks locally downloaded bytes against source catalog when available", (t) => {
    let checked = 0;
    for (const model of parseOcrCatalog(fixture()).models) for (const file of Object.values(model.files)) {
      const path = new URL(`../../../apps/web/public${file.url}`, import.meta.url);
      if (existsSync(path)) { assert.equal(statSync(path).size, file.sizeBytes, file.url); checked++; }
    }
    if (!checked) t.skip("模型文件未下载；CI/download_models.sh 校验真实文件");
  });
});
