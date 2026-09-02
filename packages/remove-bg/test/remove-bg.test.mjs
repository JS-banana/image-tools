/**
 * Node 22 内置测试（零依赖；--experimental-strip-types 直接 import 旁路 .ts）：
 * preprocess / postprocess / compose 数值契约，以及 RemoveBgRuntime 生命周期。
 * 经 loader/factory/pipeline 替身注入；不 import pipeline、不触达 onnxruntime-web。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { compose } from "../src/compose.ts";
import { postprocess } from "../src/postprocess.ts";
import { preprocess } from "../src/preprocess.ts";
import { RemoveBgRuntime } from "../src/runtime.ts";
import {
  ALPHA_RANGE_EPS,
  BEN2_INPUT_SIZE,
  IMAGENET_MEAN,
  IMAGENET_STD,
  InvalidAlphaError,
  InvalidComposeError,
  InvalidImageError,
  RemoveBgError,
  RuntimeClosedError,
  RuntimeNotReadyError,
  StaleRunError,
} from "../src/types.ts";

const PLANE = BEN2_INPUT_SIZE * BEN2_INPUT_SIZE;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function rgbaImage(width, height, pixels) {
  return { width, height, data: Uint8ClampedArray.from(pixels) };
}

function imagenet(r, g, b) {
  return [
    (r / 255 - IMAGENET_MEAN[0]) / IMAGENET_STD[0],
    (g / 255 - IMAGENET_MEAN[1]) / IMAGENET_STD[1],
    (b / 255 - IMAGENET_MEAN[2]) / IMAGENET_STD[2],
  ];
}

function chwAt(out, c, y, x) {
  return out[c * PLANE + y * BEN2_INPUT_SIZE + x];
}

function assertClose(actual, expected, eps = 1e-6) {
  assert.ok(
    Number.isFinite(actual) && Math.abs(actual - expected) <= eps,
    `expected ${expected} ± ${eps}, got ${actual}`,
  );
}

function assertRgbAt(out, y, x, rgb) {
  for (let c = 0; c < 3; c++) assertClose(chwAt(out, c, y, x), rgb[c]);
}

function solidChannel(src, bg, matte) {
  const a = matte / 255;
  return Math.round(src * a + bg * (1 - a));
}

function emptyAlphas() {
  return new Float32Array(PLANE);
}

function makeEntry() {
  return {
    id: "ben2-base-fp16",
    name: "BEN2 Base FP16",
    label: "通用",
    recommended: true,
    revision: "r-test",
    pipeline: "ben2-background-removal",
    files: { model: { url: "/models/ben2-base/model.onnx", sizeBytes: 8 } },
  };
}

function makeImage(width = 1, height = 1) {
  return {
    width,
    height,
    data: new Uint8ClampedArray(width * height * 4).fill(255),
  };
}

/**
 * 可控替身：gates 卡住 load/create/run；events 记录可观察顺序。
 * failLoadOnce / failCreateOnce 测失败后重试。
 */
function makeRuntime() {
  const events = [];
  const gates = { load: null, create: null, run: null };
  const failOnce = { load: false, create: false };
  let loadCalls = 0;
  let createCalls = 0;
  let runInflight = 0;
  let maxRunInflight = 0;
  let disposeCount = 0;
  const progressLog = [];

  const loadAssets = async (files, revision, onProgress) => {
    loadCalls += 1;
    events.push("load:start");
    assert.equal(revision, "r-test");
    assert.equal(files.model.url, "/models/ben2-base/model.onnx");
    const progress = {
      pct: 50,
      label: "model",
      fromCache: false,
      loadedBytes: 4,
      totalBytes: 8,
    };
    onProgress?.(progress);
    progressLog.push({ ...progress });
    if (gates.load) await gates.load.promise;
    if (failOnce.load) {
      failOnce.load = false;
      events.push("load:fail");
      throw new Error("网络错误");
    }
    events.push("load:done");
    return { files: { model: new ArrayBuffer(8) }, source: "network" };
  };

  const createPipeline = async (entry, model, backend) => {
    createCalls += 1;
    assert.equal(entry.id, "ben2-base-fp16");
    assert.equal(backend, "webgpu");
    assert.ok(model instanceof ArrayBuffer && model.byteLength > 0);
    if (gates.create) await gates.create.promise;
    if (failOnce.create) {
      failOnce.create = false;
      events.push("create:fail");
      throw new Error("Session 创建失败");
    }
    events.push("create");
    const pipeline = {
      backend,
      run: async (image) => {
        runInflight += 1;
        maxRunInflight = Math.max(maxRunInflight, runInflight);
        events.push("run:start");
        try {
          if (gates.run) await gates.run.promise;
          events.push("run:done");
          const n = image.width * image.height;
          return {
            alpha: new Uint8ClampedArray(n).fill(200),
            width: image.width,
            height: image.height,
            backend,
            preprocessMs: 1,
            inferenceMs: 2,
            postprocessMs: 3,
            totalMs: 6,
          };
        } finally {
          runInflight -= 1;
        }
      },
      dispose: async () => {
        disposeCount += 1;
        events.push("dispose");
      },
    };
    return pipeline;
  };

  const runtime = new RemoveBgRuntime({
    entry: makeEntry(),
    backend: "webgpu",
    loadAssets,
    createPipeline,
  });

  return {
    runtime,
    events,
    gates,
    failOnce,
    progressLog,
    stats: () => ({ loadCalls, createCalls, maxRunInflight, disposeCount }),
  };
}

async function waitFor(events, name) {
  for (let i = 0; i < 40; i++) {
    if (events.includes(name)) return;
    await new Promise((r) => setImmediate(r));
  }
  assert.fail(`等待事件 ${name}，实际: ${events.join(", ")}`);
}

function assertBefore(events, a, b) {
  const ia = events.indexOf(a);
  const ib = events.indexOf(b);
  assert.ok(ia !== -1, `缺少事件 ${a}（实际: ${events.join(", ")}）`);
  assert.ok(ib !== -1, `缺少事件 ${b}（实际: ${events.join(", ")}）`);
  assert.ok(ia < ib, `期望 ${a} 早于 ${b}（实际: ${events.join(", ")}）`);
}

describe("preprocess", () => {
  it("1x1 每个 1024² 采样点都是该像素的 ImageNet CHW 值", () => {
    const src = rgbaImage(1, 1, [128, 64, 32, 255]);
    const out = preprocess(src);
    assert.equal(out.length, 3 * PLANE);
    assert.ok(out instanceof Float32Array);
    const expected = imagenet(128, 64, 32);
    for (const [y, x] of [
      [0, 0],
      [0, BEN2_INPUT_SIZE - 1],
      [BEN2_INPUT_SIZE - 1, 0],
      [BEN2_INPUT_SIZE - 1, BEN2_INPUT_SIZE - 1],
      [512, 512],
    ]) {
      assertRgbAt(out, y, x, expected);
    }
  });

  it("2x2 角点落到源像素，中心为双线性混合", () => {
    const src = rgbaImage(2, 2, [
      255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255,
    ]);
    const out = preprocess(src);
    const last = BEN2_INPUT_SIZE - 1;
    assertRgbAt(out, 0, 0, imagenet(255, 0, 0));
    assertRgbAt(out, 0, last, imagenet(0, 255, 0));
    assertRgbAt(out, last, 0, imagenet(0, 0, 255));
    assertRgbAt(out, last, last, imagenet(255, 255, 0));

    const fx = 512.5 * (2 / BEN2_INPUT_SIZE) - 0.5;
    const fy = 512.5 * (2 / BEN2_INPUT_SIZE) - 0.5;
    const r = 255 * ((1 - fx) * (1 - fy) + fx * fy);
    const g = 255 * fx;
    const b = 255 * (1 - fx) * fy;
    assertRgbAt(out, 512, 512, imagenet(r, g, b));
  });

  it("全透明像素仍使用其 RGB，不把输入当成黑", () => {
    const clear = preprocess(rgbaImage(1, 1, [40, 80, 120, 0]));
    const opaque = preprocess(rgbaImage(1, 1, [40, 80, 120, 255]));
    const expected = imagenet(40, 80, 120);
    assertRgbAt(clear, 0, 0, expected);
    assertRgbAt(opaque, 0, 0, expected);
    const black = imagenet(0, 0, 0);
    assert.ok(Math.abs(chwAt(clear, 0, 0, 0) - black[0]) > 0.1);
  });

  it("非法尺寸与缓冲抛 InvalidImageError", () => {
    assert.throws(() => preprocess(null), InvalidImageError);
    assert.throws(
      () => preprocess({ width: 0, height: 1, data: new Uint8Array(0) }),
      InvalidImageError,
    );
    assert.throws(
      () => preprocess({ width: 1, height: 0, data: new Uint8Array(0) }),
      InvalidImageError,
    );
    assert.throws(
      () => preprocess({ width: -1, height: 1, data: new Uint8Array(0) }),
      InvalidImageError,
    );
    assert.throws(
      () => preprocess({ width: 1.5, height: 1, data: new Uint8Array(8) }),
      InvalidImageError,
    );
    assert.throws(
      () => preprocess({ width: 1, height: 1, data: null }),
      InvalidImageError,
    );
    assert.throws(
      () => preprocess({ width: 1, height: 1, data: new Uint8Array(3) }),
      InvalidImageError,
    );
    assert.throws(
      () => preprocess({ width: 2, height: 2, data: new Uint8Array(4) }),
      InvalidImageError,
    );
  });
});

describe("postprocess", () => {
  it("同尺寸 1024² 按 1e-6 容差 clamp 后量化，不混合邻域", () => {
    const alphas = emptyAlphas();
    alphas[0] = -ALPHA_RANGE_EPS;
    alphas[1] = 1 + ALPHA_RANGE_EPS;
    alphas[2] = 0.5;
    alphas[3] = 0;
    alphas[4] = 1;
    const out = postprocess(alphas, BEN2_INPUT_SIZE, BEN2_INPUT_SIZE);
    assert.ok(out instanceof Uint8ClampedArray);
    assert.equal(out.length, PLANE);
    assert.equal(out[0], 0);
    assert.equal(out[1], 255);
    assert.equal(out[2], 128);
    assert.equal(out[3], 0);
    assert.equal(out[4], 255);
  });

  it("越界、NaN/Inf、错误长度抛 InvalidAlphaError", () => {
    const alphas = emptyAlphas();
    alphas[0] = -2e-6;
    assert.throws(
      () => postprocess(alphas, BEN2_INPUT_SIZE, BEN2_INPUT_SIZE),
      InvalidAlphaError,
    );
    alphas[0] = 1 + 2e-6;
    assert.throws(
      () => postprocess(alphas, BEN2_INPUT_SIZE, BEN2_INPUT_SIZE),
      InvalidAlphaError,
    );
    alphas[0] = Number.NaN;
    assert.throws(
      () => postprocess(alphas, BEN2_INPUT_SIZE, BEN2_INPUT_SIZE),
      InvalidAlphaError,
    );
    alphas[0] = Number.POSITIVE_INFINITY;
    assert.throws(
      () => postprocess(alphas, BEN2_INPUT_SIZE, BEN2_INPUT_SIZE),
      InvalidAlphaError,
    );
    alphas[0] = Number.NEGATIVE_INFINITY;
    assert.throws(
      () => postprocess(alphas, BEN2_INPUT_SIZE, BEN2_INPUT_SIZE),
      InvalidAlphaError,
    );
    assert.throws(
      () => postprocess(new Float32Array(10), BEN2_INPUT_SIZE, BEN2_INPUT_SIZE),
      InvalidAlphaError,
    );
    assert.throws(
      () => postprocess(null, BEN2_INPUT_SIZE, BEN2_INPUT_SIZE),
      InvalidAlphaError,
    );
  });

  it("非法回采样尺寸抛 InvalidImageError", () => {
    const alphas = emptyAlphas();
    assert.throws(() => postprocess(alphas, 0, 1), InvalidImageError);
    assert.throws(() => postprocess(alphas, 1, -1), InvalidImageError);
    assert.throws(() => postprocess(alphas, 1.5, 1), InvalidImageError);
  });

  it("回采样到 2×2 使用双线性", () => {
    const alphas = emptyAlphas();
    const set = (x, y, v) => {
      alphas[y * BEN2_INPUT_SIZE + x] = v;
    };
    set(255, 255, 0.0);
    set(256, 255, 0.2);
    set(255, 256, 0.4);
    set(256, 256, 0.6);
    const out = postprocess(alphas, 2, 2);
    assert.equal(out.length, 4);
    // dest(0,0) 采样 (255.5, 255.5)，fx=fy=0.5 → 0.3 → round(76.5)=77
    assert.equal(out[0], 77);

    set(767, 255, 1);
    set(768, 255, 1);
    set(767, 256, 1);
    set(768, 256, 1);
    const out2 = postprocess(alphas, 2, 2);
    assert.equal(out2[1], 255);

    const one = postprocess(alphas, 1, 1);
    assert.equal(one.length, 1);
    assert.ok(one[0] >= 0 && one[0] <= 255);
  });
});

describe("compose", () => {
  it("透明模式保留源 RGB，alpha 取 matte，忽略源 A", () => {
    const source = rgbaImage(1, 1, [100, 150, 200, 9]);
    const out = compose(source, [128], "transparent");
    assert.ok(out instanceof Uint8ClampedArray);
    assert.deepEqual(Array.from(out), [100, 150, 200, 128]);
  });

  it("纯色模式逐通道 round(src*a+bg*(1-a)) 且 A=255", () => {
    const source = rgbaImage(2, 1, [100, 150, 200, 1, 0, 0, 0, 2]);
    const matte = [128, 0];
    const bg = [10, 20, 30];
    const out = compose(source, matte, bg);
    assert.equal(out.length, 8);
    assert.equal(out[0], solidChannel(100, 10, 128));
    assert.equal(out[1], solidChannel(150, 20, 128));
    assert.equal(out[2], solidChannel(200, 30, 128));
    assert.equal(out[3], 255);
    assert.deepEqual(Array.from(out.subarray(4, 8)), [10, 20, 30, 255]);

    const fg = compose(rgbaImage(1, 1, [7, 8, 9, 0]), [255], [10, 20, 30]);
    assert.deepEqual(Array.from(fg), [7, 8, 9, 255]);
  });

  it("非法 matte / 纯色抛 InvalidComposeError", () => {
    const source = rgbaImage(1, 1, [1, 2, 3, 4]);
    assert.throws(() => compose(source, null, "transparent"), InvalidComposeError);
    assert.throws(() => compose(source, [], "transparent"), InvalidComposeError);
    assert.throws(() => compose(source, [256], "transparent"), InvalidComposeError);
    assert.throws(() => compose(source, [-1], "transparent"), InvalidComposeError);
    assert.throws(() => compose(source, [Number.NaN], "transparent"), InvalidComposeError);
    assert.throws(
      () => compose(source, [Number.POSITIVE_INFINITY], [0, 0, 0]),
      InvalidComposeError,
    );
    assert.throws(() => compose(source, [255], [1, 2]), InvalidComposeError);
    assert.throws(() => compose(source, [255], [256, 0, 0]), InvalidComposeError);
    assert.throws(() => compose(source, [255], [0, 0.5, 0]), InvalidComposeError);
    assert.throws(() => compose(source, [255], "white"), InvalidComposeError);
    assert.throws(() => compose(source, [255], [0, 0, 0, 0]), InvalidComposeError);
  });

  it("非法源图走 InvalidImageError", () => {
    assert.throws(
      () =>
        compose({ width: 1, height: 1, data: new Uint8Array(2) }, [0], "transparent"),
      InvalidImageError,
    );
  });
});

describe("RemoveBgRuntime 加载", () => {
  it("并发 load 共享同一 Promise，只下载一次并只建一次 Pipeline", async () => {
    const { runtime, events, progressLog, stats } = makeRuntime();
    const p1 = runtime.load((p) => progressLog.push({ ...p, extra: true }));
    const p2 = runtime.load();
    assert.equal(p1, p2);
    await Promise.all([p1, p2]);
    assert.equal(stats().loadCalls, 1);
    assert.equal(stats().createCalls, 1);
    assert.equal(events.filter((e) => e === "load:start").length, 1);
    assert.equal(events.filter((e) => e === "create").length, 1);
    assert.ok(progressLog.some((p) => p.loadedBytes === 4 && p.totalBytes === 8));

    await runtime.load();
    assert.equal(stats().loadCalls, 1);
    assert.equal(stats().createCalls, 1);
    await runtime.dispose();
  });

  it("失败后可重试；未就绪 run 抛 RuntimeNotReadyError", async () => {
    const { runtime, failOnce, events } = makeRuntime();
    await assert.rejects(runtime.run(makeImage()), RuntimeNotReadyError);

    failOnce.load = true;
    await assert.rejects(runtime.load(), /网络错误/);
    await assert.rejects(runtime.run(makeImage()), RuntimeNotReadyError);

    failOnce.create = true;
    await assert.rejects(runtime.load(), /Session 创建失败/);
    await assert.rejects(runtime.run(makeImage()), RuntimeNotReadyError);

    await runtime.load();
    const out = await runtime.run(makeImage());
    assert.equal(out.backend, "webgpu");
    assert.equal(out.width, 1);
    assert.equal(out.height, 1);
    assert.equal(out.alpha[0], 200);
    assert.ok(events.includes("load:fail"));
    assert.ok(events.includes("create:fail"));
    assert.equal(events.filter((e) => e === "create").length, 1);
    await runtime.dispose();
  });
});

describe("RemoveBgRuntime 串行 run 与 stale", () => {
  it("后发 run 使在途结果 stale，pipeline.run 始终串行", async () => {
    const { runtime, gates, events, stats } = makeRuntime();
    await runtime.load();
    gates.run = deferred();

    const first = runtime.run(makeImage(1, 1));
    await waitFor(events, "run:start");
    const second = runtime.run(makeImage(2, 1));
    gates.run.resolve();

    await assert.rejects(first, StaleRunError);
    const out = await second;
    assert.equal(out.width, 2);
    assert.equal(out.height, 1);
    assert.equal(stats().maxRunInflight, 1);
    assert.deepEqual(
      events.filter((e) => e.startsWith("run:")),
      ["run:start", "run:done", "run:start", "run:done"],
    );
    await runtime.dispose();
  });

  it("排队中尚未进入 pipeline.run 的旧请求直接 stale，不调用 run", async () => {
    const { runtime, events } = makeRuntime();
    await runtime.load();
    const first = runtime.run(makeImage());
    const second = runtime.run(makeImage());
    await assert.rejects(first, StaleRunError);
    await second;
    assert.equal(events.filter((e) => e === "run:start").length, 1);
    await runtime.dispose();
  });
});

describe("RemoveBgRuntime dispose 收口", () => {
  it("dispose 等待在途 load；关闭后不创建 Pipeline、不复活", async () => {
    const { runtime, gates, events, stats } = makeRuntime();
    gates.load = deferred();
    const loadP = runtime.load();
    const dispP = runtime.dispose();
    let disposeSettled = false;
    dispP.then(() => {
      disposeSettled = true;
    });
    await waitFor(events, "load:start");
    await new Promise((r) => setImmediate(r));
    assert.equal(disposeSettled, false);

    gates.load.resolve();
    await assert.rejects(loadP, RuntimeClosedError);
    await dispP;
    assert.ok(!events.includes("create"));
    assert.equal(stats().disposeCount, 0);
    await assert.rejects(runtime.load(), RuntimeClosedError);
    await assert.rejects(runtime.run(makeImage()), RuntimeClosedError);
    await runtime.dispose();
    assert.equal(stats().loadCalls, 1);
    assert.equal(stats().createCalls, 0);
  });

  it("创建中 dispose：创建完成后立即释放，且只释放一次", async () => {
    const { runtime, gates, events, stats } = makeRuntime();
    gates.create = deferred();
    const loadP = runtime.load();
    await waitFor(events, "load:done");
    const dispP = runtime.dispose();
    let disposeSettled = false;
    dispP.then(() => {
      disposeSettled = true;
    });
    await new Promise((r) => setImmediate(r));
    assert.equal(disposeSettled, false);

    gates.create.resolve();
    await assert.rejects(loadP, RuntimeClosedError);
    await dispP;
    assert.equal(events.filter((e) => e === "dispose").length, 1);
    assert.equal(stats().disposeCount, 1);
    await runtime.dispose();
    assert.equal(stats().disposeCount, 1);
    await assert.rejects(runtime.load(), RuntimeClosedError);
    await assert.rejects(runtime.run(makeImage()), RuntimeClosedError);
  });

  it("dispose 等待在途 run，随后拒绝 load/run，资源只释放一次", async () => {
    const { runtime, gates, events, stats } = makeRuntime();
    await runtime.load();
    gates.run = deferred();
    const runP = runtime.run(makeImage());
    await waitFor(events, "run:start");
    const dispP = runtime.dispose();
    let disposeSettled = false;
    dispP.then(() => {
      disposeSettled = true;
    });
    await new Promise((r) => setImmediate(r));
    assert.equal(disposeSettled, false);

    gates.run.resolve();
    await assert.rejects(runP, RuntimeClosedError);
    await dispP;
    assertBefore(events, "run:done", "dispose");
    assert.equal(stats().disposeCount, 1);
    await runtime.dispose();
    assert.equal(stats().disposeCount, 1);
    await assert.rejects(runtime.load(), RuntimeClosedError);
    await assert.rejects(runtime.run(makeImage()), RuntimeClosedError);
  });

  it("非法 entry/backend 构造即失败", () => {
    assert.throws(
      () =>
        new RemoveBgRuntime({
          entry: { ...makeEntry(), pipeline: "ppocr-dbnet-ctc" },
          backend: "webgpu",
          loadAssets: async () => {
            throw new Error("unused");
          },
          createPipeline: async () => {
            throw new Error("unused");
          },
        }),
      RemoveBgError,
    );
    assert.throws(
      () =>
        new RemoveBgRuntime({
          entry: makeEntry(),
          backend: "cpu",
          loadAssets: async () => {
            throw new Error("unused");
          },
          createPipeline: async () => {
            throw new Error("unused");
          },
        }),
      RemoveBgError,
    );
  });
});
