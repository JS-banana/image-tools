import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { describe, it } from "node:test";
import { ManifestError, toModelSummary } from "@img/model-runtime";
import { isBen2RemoveBgModelEntry, parseRemoveBgCatalog } from "../src/models.ts";

const fixture = () => JSON.parse(readFileSync(new URL("../models.json", import.meta.url), "utf8"));

describe("remove-background model catalog", () => {
  it("validates the independent BEN2 source and byte size", () => {
    const { models } = parseRemoveBgCatalog(fixture());
    assert.equal(models.length, 1);
    assert.equal(models[0].id, "ben2-base-fp16");
    assert.equal(models[0].recommended, true);
    assert.equal(models[0].files.model.url, "/models/ben2-base/model.onnx");
    assert.equal(models[0].files.model.sizeBytes, 219121675);
    assert.equal(toModelSummary(models[0]).downloadBytes, 219121675);
    assert.ok(isBen2RemoveBgModelEntry(models[0]));
    assert.equal(isBen2RemoveBgModelEntry({ pipeline: "ppocr-dbnet-ctc" }), false);
  });
  it("rejects unrelated pipeline, malformed files, paths and sizes", () => {
    for (const change of [
      (m) => { m.pipeline = "ppocr-dbnet-ctc"; },
      (m) => { m.files = {}; },
      (m) => { m.files = { det: m.files.model, rec: m.files.model, dict: m.files.model }; },
      (m) => { m.files.extra = m.files.model; },
      (m) => { m.files = "models/a"; },
      (m) => { m.files.model = "models/a"; },
      (m) => { m.files.model.url = "https://evil.example/model.onnx"; },
      (m) => { m.files.model.sizeBytes = 0; },
    ]) { const raw = fixture(); change(raw.models[0]); assert.throws(() => parseRemoveBgCatalog(raw), ManifestError); }
  });
  it("requires unique ids and exactly one recommendation", () => {
    const none = fixture(); none.models[0].recommended = false;
    assert.throws(() => parseRemoveBgCatalog(none), /当前 0 个/);
    const duplicate = fixture(); duplicate.models.push(structuredClone(duplicate.models[0]));
    assert.throws(() => parseRemoveBgCatalog(duplicate), /重复/);
    duplicate.models[1].id = "another-ben2";
    assert.throws(() => parseRemoveBgCatalog(duplicate), /当前 2 个/);
  });
  it("checks downloaded model size when available", (t) => {
    const model = parseRemoveBgCatalog(fixture()).models[0].files.model;
    const path = new URL(`../../../apps/web/public${model.url}`, import.meta.url);
    if (!existsSync(path)) { t.skip("模型文件未下载；CI/download_models.sh 校验真实文件"); return; }
    assert.equal(statSync(path).size, model.sizeBytes);
  });
});
