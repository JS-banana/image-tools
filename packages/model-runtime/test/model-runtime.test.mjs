/**
 * Node 22 内置测试（零依赖；--experimental-strip-types 直接 import 旁路 .ts）：
 * 联合 catalog 解析、type guards、每 pipeline recommended、summary/cache keys、
 * 真实 models.json 与本地资产 sizeBytes。
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  ManifestError,
  assetCacheKey,
  catalogCacheKeys,
  parseModelCatalog,
  toModelSummary,
  withBasePath,
} from "../src/manifest.ts";
import {
  isBen2RemoveBgModelEntry,
  isPpocrModelEntry,
} from "../src/types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../../..");

const TINY = "ppocrv6-tiny";
const SMALL = "ppocrv6-small";
const MEDIUM = "ppocrv6-medium";
const BEN2 = "ben2-base-fp16";
const BEN2_SIZE = 219121675;

function manifestFixture() {
  return JSON.parse(readFileSync(join(ROOT, "apps/web/public/models.json"), "utf8"));
}

describe("withBasePath", () => {
  it("leaves paths unchanged when BASE_PATH is empty", () => {
    assert.equal(withBasePath("/models.json"), "/models.json");
    assert.equal(withBasePath("/ort/"), "/ort/");
  });

  it("prefixes site-root paths when NEXT_PUBLIC_BASE_PATH is set", () => {
    const prev = process.env.NEXT_PUBLIC_BASE_PATH;
    process.env.NEXT_PUBLIC_BASE_PATH = "/image-tools";
    try {
      assert.equal(withBasePath("/models.json"), "/image-tools/models.json");
      assert.equal(withBasePath("/ort/"), "/image-tools/ort/");
      assert.equal(withBasePath("/image-tools/models.json"), "/image-tools/models.json");
    } finally {
      if (prev === undefined) delete process.env.NEXT_PUBLIC_BASE_PATH;
      else process.env.NEXT_PUBLIC_BASE_PATH = prev;
    }
  });
});

describe("parseModelCatalog", () => {
  it("accepts the checked-in mixed 4-entry manifest", () => {
    const catalog = parseModelCatalog(manifestFixture());
    assert.equal(catalog.models.length, 4);
    assert.deepEqual(
      catalog.models.map((m) => m.id),
      [TINY, SMALL, MEDIUM, BEN2],
    );

    const ppocr = catalog.models.filter(isPpocrModelEntry);
    const ben2 = catalog.models.filter(isBen2RemoveBgModelEntry);
    assert.equal(ppocr.length, 3);
    assert.equal(ben2.length, 1);

    const tiny = ppocr[0];
    assert.equal(tiny.id, TINY);
    assert.equal(tiny.pipeline, "ppocr-dbnet-ctc");
    assert.equal(tiny.recommended, true);
    assert.equal(tiny.params.colorOrder, "BGR");
    assert.equal(tiny.params.boxThresh, 0.4);
    assert.equal(tiny.params.dictSize, 6906);
    assert.equal(tiny.files.det.url, "/models/ppocrv6-tiny/det.onnx");
    assert.equal(tiny.files.dict.url, "/models/ppocrv6-tiny/dict.json");

    for (const m of [ppocr[1], ppocr[2]]) {
      assert.equal(m.recommended, false);
      assert.equal(m.params.boxThresh, 0.45);
      assert.equal(m.params.dictSize, 18710);
      assert.equal(m.files.dict.url, `/models/${m.id}/dict.json`);
      assert.equal(isBen2RemoveBgModelEntry(m), false);
    }

    const ben2Entry = ben2[0];
    assert.equal(ben2Entry.id, BEN2);
    assert.equal(ben2Entry.pipeline, "ben2-background-removal");
    assert.equal(ben2Entry.recommended, true);
    assert.equal(ben2Entry.files.model.url, "/models/ben2-base/model.onnx");
    assert.equal(ben2Entry.files.model.sizeBytes, BEN2_SIZE);
    assert.equal(isPpocrModelEntry(ben2Entry), false);
  });

  it("parses an OCR-only catalog when BEN2 is absent", () => {
    const raw = manifestFixture();
    raw.models = raw.models.filter((m) => m.pipeline === "ppocr-dbnet-ctc");
    const catalog = parseModelCatalog(raw);
    assert.equal(catalog.models.length, 3);
    assert.ok(catalog.models.every(isPpocrModelEntry));
  });

  it("parses a BEN2-only catalog when OCR is absent", () => {
    const raw = manifestFixture();
    raw.models = raw.models.filter((m) => m.pipeline === "ben2-background-removal");
    const catalog = parseModelCatalog(raw);
    assert.equal(catalog.models.length, 1);
    assert.ok(isBen2RemoveBgModelEntry(catalog.models[0]));
    assert.equal(catalog.models[0].files.model.sizeBytes, BEN2_SIZE);
  });

  it("rejects zero recommended flags for a present pipeline", () => {
    const raw = manifestFixture();
    for (const m of raw.models) {
      if (m.pipeline === "ppocr-dbnet-ctc") m.recommended = false;
    }
    assert.throws(
      () => parseModelCatalog(raw),
      (err) => {
        assert.ok(err instanceof ManifestError);
        assert.match(err.message, /ppocr-dbnet-ctc/);
        assert.match(err.message, /recommended/);
        assert.match(err.message, /当前 0 个/);
        return true;
      },
    );

    const rawBen2 = manifestFixture();
    for (const m of rawBen2.models) {
      if (m.pipeline === "ben2-background-removal") m.recommended = false;
    }
    assert.throws(
      () => parseModelCatalog(rawBen2),
      (err) => {
        assert.ok(err instanceof ManifestError);
        assert.match(err.message, /ben2-background-removal/);
        assert.match(err.message, /recommended/);
        assert.match(err.message, /当前 0 个/);
        return true;
      },
    );
  });

  it("rejects two recommended flags for the same pipeline", () => {
    const rawPpocr = manifestFixture();
    rawPpocr.models[1].recommended = true;
    assert.throws(
      () => parseModelCatalog(rawPpocr),
      (err) => {
        assert.ok(err instanceof ManifestError);
        assert.match(err.message, /ppocr-dbnet-ctc/);
        assert.match(err.message, /recommended/);
        assert.match(err.message, /当前 2 个/);
        return true;
      },
    );

    const rawBen2 = manifestFixture();
    const extra = structuredClone(rawBen2.models[3]);
    extra.id = "ben2-other";
    extra.files.model.url = "/models/ben2-other/model.onnx";
    rawBen2.models.push(extra);
    assert.throws(
      () => parseModelCatalog(rawBen2),
      (err) => {
        assert.ok(err instanceof ManifestError);
        assert.match(err.message, /ben2-background-removal/);
        assert.match(err.message, /recommended/);
        assert.match(err.message, /当前 2 个/);
        return true;
      },
    );
  });

  it("rejects unknown pipeline before any loader would run", () => {
    const raw = manifestFixture();
    raw.models[0] = { ...raw.models[0], pipeline: "unknown-pipe" };
    assert.throws(
      () => parseModelCatalog(raw),
      (err) => {
        assert.ok(err instanceof ManifestError);
        assert.match(err.message, /unknown-pipe/);
        assert.match(err.message, /pipeline/);
        return true;
      },
    );
  });

  it("rejects illegal Ben2 files shapes", () => {
    const cases = [
      [{}, /恰好包含 model/],
      [
        {
          det: { url: "/models/ben2-base/det.onnx", sizeBytes: 1 },
          rec: { url: "/models/ben2-base/rec.onnx", sizeBytes: 1 },
          dict: { url: "/models/ben2-base/dict.json", sizeBytes: 1 },
        },
        /恰好包含 model/,
      ],
      [
        {
          model: { url: "/models/ben2-base/model.onnx", sizeBytes: BEN2_SIZE },
          extra: { url: "/models/ben2-base/extra.bin", sizeBytes: 1 },
        },
        /恰好包含 model/,
      ],
      ["models/x.onnx", /必须是对象/],
      [{ model: "models/x.onnx" }, /files\.model/],
      [
        { model: { url: "https://evil.example/model.onnx", sizeBytes: BEN2_SIZE } },
        /files\.model\.url/,
      ],
    ];
    for (const [files, re] of cases) {
      const raw = manifestFixture();
      raw.models[3] = { ...raw.models[3], files };
      assert.throws(
        () => parseModelCatalog(raw),
        (err) => {
          assert.ok(err instanceof ManifestError, `expected ManifestError for ${JSON.stringify(files)}`);
          assert.match(err.message, /ben2-base-fp16/);
          assert.match(err.message, re);
          return true;
        },
        `should reject Ben2 files ${JSON.stringify(files)}`,
      );
    }
  });

  it("rejects missing PP-OCR params with model id and field path", () => {
    const raw = manifestFixture();
    const params = { ...raw.models[0].params };
    delete params.boxThresh;
    raw.models[0] = { ...raw.models[0], params };
    assert.throws(
      () => parseModelCatalog(raw),
      (err) => {
        assert.ok(err instanceof ManifestError);
        assert.match(err.message, /ppocrv6-tiny/);
        assert.match(err.message, /params\.boxThresh/);
        return true;
      },
    );
  });

  it("rejects files that are plain strings (legacy shape)", () => {
    const raw = manifestFixture();
    raw.models[0] = {
      ...raw.models[0],
      files: {
        det: "models/x.onnx",
        rec: "models/y.onnx",
        dict: "models/z.json",
      },
    };
    assert.throws(
      () => parseModelCatalog(raw),
      (err) => {
        assert.ok(err instanceof ManifestError);
        assert.match(err.message, /files\.det/);
        return true;
      },
    );
  });

  it("rejects duplicate ids within and across pipelines", () => {
    const same = manifestFixture();
    const clone = structuredClone(same.models[0]);
    same.models.push(clone);
    assert.throws(
      () => parseModelCatalog(same),
      (err) => {
        assert.ok(err instanceof ManifestError);
        assert.match(err.message, /重复/);
        return true;
      },
    );

    const cross = manifestFixture();
    cross.models[3] = { ...cross.models[3], id: TINY };
    assert.throws(
      () => parseModelCatalog(cross),
      (err) => {
        assert.ok(err instanceof ManifestError);
        assert.match(err.message, /重复/);
        assert.match(err.message, new RegExp(TINY));
        return true;
      },
    );
  });

  it("rejects non-BGR colorOrder", () => {
    const raw = manifestFixture();
    const params = {
      ...raw.models[0].params,
      colorOrder: "RGB",
    };
    raw.models[0] = { ...raw.models[0], params };
    assert.throws(
      () => parseModelCatalog(raw),
      (err) => {
        assert.ok(err instanceof ManifestError);
        assert.match(err.message, /colorOrder/);
        return true;
      },
    );
  });

  it("rejects backslash / external / query-hash / traversal asset URLs", () => {
    const cases = [
      ["/\\\\evil.example/model.onnx", /反斜杠|外部|models/],
      ["https://evil.example/model.onnx", /外部/],
      ["//evil.example/model.onnx", /外部|本站/],
      ["/models/x.onnx?x=1", /query|hash/],
      ["/models/x.onnx#frag", /query|hash/],
      ["/models/../secret.onnx", /models|穿越|规范/],
      ["/ort/ort.wasm", /models/],
      ["models/x.onnx", /开头/],
    ];
    for (const [url, re] of cases) {
      const raw = manifestFixture();
      raw.models[0] = {
        ...raw.models[0],
        files: {
          ...raw.models[0].files,
          det: { url, sizeBytes: 100 },
        },
      };
      assert.throws(
        () => parseModelCatalog(raw),
        (err) => {
          assert.ok(err instanceof ManifestError, `expected ManifestError for ${url}`);
          assert.match(err.message, /files\.det\.url/);
          assert.match(err.message, re);
          return true;
        },
        `should reject ${url}`,
      );
    }
  });

  it("rejects non-integer detMaxSide / recHeight / recMaxWidth", () => {
    for (const key of ["detMaxSide", "recHeight", "recMaxWidth"]) {
      const raw = manifestFixture();
      raw.models[0] = {
        ...raw.models[0],
        params: { ...raw.models[0].params, [key]: 48.5 },
      };
      assert.throws(
        () => parseModelCatalog(raw),
        (err) => {
          assert.ok(err instanceof ManifestError);
          assert.match(err.message, new RegExp(`params\\.${key}`));
          assert.match(err.message, /正整数/);
          return true;
        },
        `should reject fractional ${key}`,
      );
    }
  });
});

describe("summary and catalog revision cache keys", () => {
  it("sums every files.* sizeBytes for OCR and BEN2 entries", () => {
    const catalog = parseModelCatalog(manifestFixture());
    const tiny = catalog.models.find((m) => m.id === TINY);
    const ben2 = catalog.models.find((m) => m.id === BEN2);
    assert.ok(tiny && isPpocrModelEntry(tiny));
    assert.ok(ben2 && isBen2RemoveBgModelEntry(ben2));

    const tinySummary = toModelSummary(tiny);
    assert.equal(tinySummary.id, TINY);
    assert.equal(tinySummary.recommended, true);
    assert.equal(
      tinySummary.downloadBytes,
      tiny.files.det.sizeBytes + tiny.files.rec.sizeBytes + tiny.files.dict.sizeBytes,
    );

    const ben2Summary = toModelSummary(ben2);
    assert.equal(ben2Summary.id, BEN2);
    assert.equal(ben2Summary.recommended, true);
    assert.equal(ben2Summary.downloadBytes, BEN2_SIZE);
    assert.equal(ben2Summary.downloadBytes, ben2.files.model.sizeBytes);
  });

  it("builds whole-catalog revision keys for each model file URL", () => {
    assert.equal(
      assetCacheKey("/models/test/det.onnx", "release 1"),
      "/models/test/det.onnx?rev=release%201",
    );
    const catalog = parseModelCatalog(manifestFixture());
    const keys = catalogCacheKeys(catalog);
    // 三档 OCR 各 det/rec/dict + BEN2 model，共 10 个独立 Cache 键
    assert.equal(keys.size, 10);
    for (const m of catalog.models) {
      for (const file of Object.values(m.files)) {
        const expected = assetCacheKey(file.url, m.revision);
        assert.ok(keys.has(expected), `missing key ${expected}`);
        assert.match(expected, /\?rev=/);
        assert.ok(expected.startsWith(file.url));
      }
    }
  });
});

describe("local asset byte sizes", () => {
  it("matches models.json sizeBytes to on-disk files when present", (t) => {
    const catalog = parseModelCatalog(manifestFixture());
    const publicRoot = join(ROOT, "apps/web/public");
    let checked = 0;
    const missing = [];
    for (const m of catalog.models) {
      for (const [name, file] of Object.entries(m.files)) {
        const disk = join(publicRoot, file.url.replace(/^\//, ""));
        if (!existsSync(disk)) {
          missing.push(`${m.id}/${name}`);
          continue;
        }
        const actual = statSync(disk).size;
        assert.equal(
          actual,
          file.sizeBytes,
          `${m.id}/${name}: disk ${actual} ≠ sizeBytes ${file.sizeBytes} (${file.url})`,
        );
        checked++;
      }
    }
    if (checked === 0) {
      t.skip(`缺少全部本地权重 ${missing.length} 个（先跑 download_models.sh）`);
    }
  });
});
