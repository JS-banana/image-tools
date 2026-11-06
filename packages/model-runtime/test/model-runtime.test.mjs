import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ManifestError, assetCacheKey, catalogCacheKeys, parseAssetFile, parseCatalog, toModelSummary } from "../src/manifest.ts";

const entry = () => ({ id: "a", name: "A", label: "test", recommended: true, revision: "r1", pipeline: "example", files: { one: { url: "/assets/a.bin", sizeBytes: 7 }, two: { url: "/assets/b.bin", sizeBytes: 11 } } });

describe("generic catalog and assets", () => {
  it("validates catalog structure, duplicate ids and recommendations without knowing any pipeline", () => {
    const parse = (raw) => parseCatalog(raw, (value) => value);
    for (const raw of [null, [], {}, { models: [] }, { models: [null] }]) assert.throws(() => parse(raw), ManifestError);
    assert.deepEqual(parse({ models: [entry()] }).models[0], entry());
    assert.throws(() => parse({ models: [entry(), entry()] }), /重复/);
    assert.throws(() => parse({ models: [{ ...entry(), recommended: false }] }), /当前 0 个/);
    assert.throws(() => parse({ models: [entry(), { ...entry(), id: "b" }] }), /当前 2 个/);
  });
  it("summarizes bytes and keys structurally", () => {
    const model = entry();
    assert.equal(toModelSummary(model).downloadBytes, 18);
    assert.equal(assetCacheKey("/assets/a", "release 1"), "/assets/a?rev=release%201");
    assert.deepEqual([...catalogCacheKeys({ models: [model] })], ["/assets/a.bin?rev=r1", "/assets/b.bin?rev=r1"]);
  });
  it("accepts canonical asset paths without a host-specific directory", () => {
    assert.deepEqual(parseAssetFile({ url: "/assets/a.bin", sizeBytes: 2 }, "files.one", "a"), { url: "/assets/a.bin", sizeBytes: 2 });
  });
  it("preserves a declared content digest and rejects malformed digests", () => {
    const file = { url: "/assets/a.bin", sizeBytes: 2, sha256: "a".repeat(64) };
    assert.deepEqual(parseAssetFile(file, "files.one", "a"), file);
    for (const sha256 of [null, 42, "", "a".repeat(63), "A".repeat(64), "g".repeat(64)]) {
      assert.throws(() => parseAssetFile({ ...file, sha256 }, "files.one", "a"), /files\.one\.sha256/);
    }
  });
  it("rejects unsafe logical paths before URL normalization", () => {
    for (const url of ["/models/../secret", "/models/%2e%2e/secret", "/models/%2F../secret", "/models//a", "/models/a?x=1", "/models/a#frag", "https://elsewhere/a", "//elsewhere/a", "/\\elsewhere/a", "models/a"]) {
      assert.throws(() => parseAssetFile({ url, sizeBytes: 1 }, "files.one", "a"), ManifestError, url);
    }
  });
  it("rejects malformed asset descriptors", () => {
    for (const raw of [null, "a", {}, { url: "/assets/a", sizeBytes: 0 }, { url: "/assets/a", sizeBytes: -1 }, { url: "/assets/a", sizeBytes: 1.5 }, { url: "/assets/a", sizeBytes: Infinity }]) {
      assert.throws(() => parseAssetFile(raw, "files.one", "a"), ManifestError);
    }
  });
});
