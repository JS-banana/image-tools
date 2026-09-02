/**
 * Node 22 内置测试：OcrRuntime 生命周期契约（迁自 @img/model-runtime）。
 * Promise 去重、stale 不建/即毁 Session、Medium 独占、失败重试、
 * 运行期拒绝切换、dispose 后不复活。显式 exclusiveIds，不因迁包弱化断言。
 * OcrPipeline / OcrRunResult / ProgressFn 见 ../src/types.ts（无运行时导出）；
 * Ppocr 条目由夹具字面量给出，无需运行时 import。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  OcrRuntime,
  RuntimeBusyError,
  RuntimeClosedError,
  StaleSelectionError,
} from "../src/runtime.ts";

const TINY = "ppocrv6-tiny";
const SMALL = "ppocrv6-small";
const MEDIUM = "ppocrv6-medium";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeEntry(id, recommended = false) {
  return {
    id,
    name: id,
    label: id,
    recommended,
    revision: "r1",
    pipeline: "ppocr-dbnet-ctc",
    files: {
      det: { url: `/models/${id}_det.onnx`, sizeBytes: 11 },
      rec: { url: `/models/${id}_rec.onnx`, sizeBytes: 13 },
      dict: { url: `/models/${id}_dict.json`, sizeBytes: 17 },
    },
    params: {
      detMaxSide: 960,
      recHeight: 48,
      recMaxWidth: 3200,
      dictSize: 6906,
      colorOrder: "BGR",
      detThresh: 0.2,
      boxThresh: 0.4,
      unclipRatio: 1.4,
      minBoxSide: 3,
    },
  };
}

const FAKE_IMAGE = { width: 2, height: 2, data: new Uint8ClampedArray(16) };

/**
 * 可控替身：gates 控制 load/create/run 何时放行；events 记录全局顺序。
 * failLoadOnce / failCreateOnce：指定模型首次对应阶段抛错（测重试）。
 */
function makeRuntime({ ids = [TINY, SMALL, MEDIUM], exclusiveIds } = {}) {
  const events = [];
  const gates = { load: null, create: null, run: null };
  const failOnce = { load: new Set(), create: new Set() };
  const catalog = {
    models: ids.map((id, i) => makeEntry(id, i === 0)),
  };

  const loadAssets = async (files, revision, onProgress) => {
    const id = files.det.url.replace("/models/", "").replace("_det.onnx", "");
    events.push(`load:start:${id}`);
    onProgress?.({
      pct: 42,
      label: "下载 det",
      fromCache: false,
      loadedBytes: 11,
      totalBytes: 41,
    });
    if (gates.load) await gates.load.promise;
    if (failOnce.load.delete(id)) {
      events.push(`load:fail:${id}`);
      throw new Error(`网络错误(${id})`);
    }
    events.push(`load:done:${id}`);
    return {
      files: {
        det: new ArrayBuffer(11),
        rec: new ArrayBuffer(13),
        dict: new ArrayBuffer(17),
      },
      source: "network",
    };
  };

  const createPipeline = async (entry, files) => {
    const id = entry.id;
    assert.ok(files.det && files.rec && files.dict, "factory 需要 det/rec/dict 字节");
    if (gates.create) await gates.create.promise;
    if (failOnce.create.delete(id)) {
      events.push(`create:fail:${id}`);
      throw new Error(`Session 创建失败(${id})`);
    }
    events.push(`create:${id}`);
    const pipeline = {
      backend: `fake-${id}`,
      run: async () => {
        events.push(`run:start:${id}`);
        if (gates.run) await gates.run.promise;
        events.push(`run:done:${id}`);
        return {
          results: [],
          boxesFound: 0,
          detMs: 1,
          recMs: 1,
          totalMs: 2,
          backend: `fake-${id}`,
        };
      },
      dispose: async () => {
        events.push(`dispose:${id}`);
      },
    };
    return pipeline;
  };

  const stateLog = [];
  const progressLog = [];
  const runtime = new OcrRuntime({
    catalog,
    loadAssets,
    createPipeline,
    exclusiveIds: exclusiveIds ?? new Set([MEDIUM]),
    onState: (id, s) => stateLog.push(`${id}:${s.phase}`),
    onLoadProgress: (id, p) => progressLog.push({ id, ...p }),
  });
  return { runtime, events, gates, failOnce, stateLog, progressLog };
}

function assertBefore(events, a, b) {
  const ia = events.indexOf(a);
  const ib = events.indexOf(b);
  assert.ok(ia !== -1, `缺少事件 ${a}（实际: ${events.join(", ")}）`);
  assert.ok(ib !== -1, `缺少事件 ${b}（实际: ${events.join(", ")}）`);
  assert.ok(ia < ib, `期望 ${a} 早于 ${b}（实际: ${events.join(", ")}）`);
}

describe("OcrRuntime 去重与选择", () => {
  it("并发选择同一模型共享一次下载与一次 Session 创建", async () => {
    const { runtime, events } = makeRuntime();
    const p1 = runtime.select(TINY);
    const p2 = runtime.select(TINY);
    await assert.rejects(p1, StaleSelectionError);
    const pipeline = await p2;
    assert.equal(pipeline.backend, `fake-${TINY}`);
    assert.equal(
      events.filter((e) => e === `load:start:${TINY}`).length,
      1,
    );
    assert.equal(events.filter((e) => e === `create:${TINY}`).length, 1);

    const again = await runtime.select(TINY);
    assert.equal(again, pipeline);
    assert.equal(
      events.filter((e) => e === `load:start:${TINY}`).length,
      1,
    );
    assert.equal(events.filter((e) => e === `create:${TINY}`).length, 1);
    assert.equal(runtime.state(TINY).phase, "ready");
    await runtime.dispose();
  });

  it("快速连续切换，最终状态只属于最后选择项", async () => {
    const { runtime, events } = makeRuntime();
    const picks = [
      runtime.select(TINY).catch((e) => e),
      runtime.select(SMALL).catch((e) => e),
      runtime.select(MEDIUM).catch((e) => e),
      runtime.select(TINY).catch((e) => e),
    ];
    const last = runtime.select(SMALL);
    const settled = await Promise.all([...picks, last]);
    for (const r of settled.slice(0, -1)) {
      assert.ok(r instanceof StaleSelectionError, `期望 stale，实际 ${r}`);
    }
    await last;
    assert.equal(runtime.selectedId(), SMALL);
    assert.equal(runtime.state(SMALL).phase, "ready");
    assert.equal(runtime.state(TINY).phase, "unloaded");
    assert.equal(runtime.state(MEDIUM).phase, "unloaded");
    assert.equal(events.filter((e) => e.startsWith("create:")).length, 1);
    assert.ok(events.includes(`create:${SMALL}`));
    await runtime.dispose();
  });

  it("进度与状态事件向外投影", async () => {
    const { runtime, stateLog, progressLog } = makeRuntime();
    await runtime.select(TINY);
    assert.deepEqual(progressLog, [
      {
        id: TINY,
        pct: 42,
        label: "下载 det",
        fromCache: false,
        loadedBytes: 11,
        totalBytes: 41,
      },
    ]);
    assert.ok(stateLog.includes(`${TINY}:loading`));
    assert.ok(stateLog.includes(`${TINY}:ready`));
    assert.equal(runtime.state(TINY).backend, `fake-${TINY}`);
    assert.equal(runtime.state(TINY).source, "network");
    await runtime.dispose();
  });
});

describe("OcrRuntime stale 与常驻策略", () => {
  it("加载中被取代：不创建 Session，槽位回到 unloaded", async () => {
    const { runtime, events, gates } = makeRuntime();
    gates.load = deferred();
    const stalePick = runtime.select(TINY);
    const winner = runtime.select(SMALL);
    gates.load.resolve();
    await assert.rejects(stalePick, StaleSelectionError);
    await winner;
    assert.ok(!events.some((e) => e === `create:${TINY}`));
    assert.equal(runtime.state(TINY).phase, "unloaded");
    assert.equal(runtime.state(SMALL).phase, "ready");
    await runtime.dispose();
  });

  it("Session 创建完成但已过期：立即 dispose，不进入常驻", async () => {
    const { runtime, events, gates } = makeRuntime();
    gates.create = deferred();
    const stalePick = runtime.select(TINY);
    await new Promise((r) => setImmediate(r));
    const winner = runtime.select(SMALL);
    gates.create.resolve();
    await assert.rejects(stalePick, StaleSelectionError);
    await winner;
    assertBefore(events, `dispose:${TINY}`, `create:${SMALL}`);
    assert.equal(runtime.state(TINY).phase, "unloaded");
    assert.equal(runtime.state(SMALL).phase, "ready");
    await runtime.dispose();
  });

  it("Tiny/Small 常驻共存，切回复用不重建", async () => {
    const { runtime, events } = makeRuntime();
    const tiny1 = await runtime.select(TINY);
    await runtime.select(SMALL);
    assert.equal(runtime.state(TINY).phase, "ready");
    assert.equal(runtime.state(SMALL).phase, "ready");
    assert.ok(!events.some((e) => e.startsWith("dispose:")));

    const tiny2 = await runtime.select(TINY);
    assert.equal(tiny2, tiny1);
    assert.equal(events.filter((e) => e === `create:${TINY}`).length, 1);
    await runtime.dispose();
  });

  it("Medium 独占：创建前释放 Tiny/Small，离开时先释放 Medium", async () => {
    const { runtime, events } = makeRuntime();
    await runtime.select(TINY);
    await runtime.select(SMALL);
    await runtime.select(MEDIUM);
    assertBefore(events, `dispose:${TINY}`, `create:${MEDIUM}`);
    assertBefore(events, `dispose:${SMALL}`, `create:${MEDIUM}`);
    assert.equal(runtime.state(TINY).phase, "unloaded");
    assert.equal(runtime.state(SMALL).phase, "unloaded");
    assert.equal(runtime.state(MEDIUM).phase, "ready");

    await runtime.select(TINY);
    assert.ok(
      events.lastIndexOf(`dispose:${MEDIUM}`) <
        events.lastIndexOf(`create:${TINY}`),
      `期望最后一次 dispose:${MEDIUM} 早于重建 create:${TINY}（实际: ${events.join(", ")}）`,
    );
    assert.equal(runtime.state(MEDIUM).phase, "unloaded");
    assert.equal(runtime.state(TINY).phase, "ready");
    await runtime.dispose();
  });

  it("防御分支：alreadyReady 快捷路径仍清除残留的独占 Session", async () => {
    const { runtime, events } = makeRuntime();
    await runtime.select(TINY);
    const slot = runtime.slots.get(MEDIUM);
    slot.pipeline = {
      backend: "fake-stuck-medium",
      run: async () => {
        throw new Error("不应运行残留 pipeline");
      },
      dispose: async () => {
        events.push(`dispose:${MEDIUM}`);
      },
    };
    slot.phase = "ready";
    slot.backend = "fake-stuck-medium";

    const pipeline = await runtime.select(TINY);
    assert.equal(pipeline.backend, `fake-${TINY}`);
    assert.ok(events.includes(`dispose:${MEDIUM}`));
    assert.equal(runtime.state(MEDIUM).phase, "unloaded");
    assert.equal(runtime.state(TINY).phase, "ready");
    assert.equal(events.filter((e) => e === `create:${TINY}`).length, 1);
    await runtime.dispose();
  });

  it("exclusiveIds 含未知 id 时构造即失败", () => {
    assert.throws(
      () => makeRuntime({ exclusiveIds: new Set(["ppocrv6-unknown"]) }),
      /未知模型 id/,
    );
  });

  it("catalog 无 medium 时默认 exclusiveIds 为空，可正常构造", () => {
    const catalog = {
      models: [
        {
          id: TINY,
          name: "Tiny",
          label: "快速",
          recommended: true,
          revision: "t",
          pipeline: "ppocr-dbnet-ctc",
          files: {
            det: { url: "/models/ppocrv6-tiny/det.onnx", sizeBytes: 11 },
            rec: { url: "/models/ppocrv6-tiny/rec.onnx", sizeBytes: 13 },
            dict: { url: "/models/ppocrv6-tiny/dict.json", sizeBytes: 17 },
          },
          params: {
            detMaxSide: 960,
            recHeight: 48,
            recMaxWidth: 3200,
            dictSize: 6906,
            colorOrder: "BGR",
            detThresh: 0.2,
            boxThresh: 0.4,
            unclipRatio: 1.4,
            minBoxSide: 3,
          },
        },
      ],
    };
    const rt = new OcrRuntime({
      catalog,
      loadAssets: async () => {
        throw new Error("unused");
      },
      createPipeline: async () => {
        throw new Error("unused");
      },
    });
    assert.deepEqual(rt.ids(), [TINY]);
    void rt.dispose();
  });

  it("显式 exclusiveIds 仍使 Medium 独占，不因迁包静默降级", async () => {
    const { runtime, events } = makeRuntime({
      exclusiveIds: new Set([MEDIUM]),
    });
    await runtime.select(TINY);
    await runtime.select(MEDIUM);
    assertBefore(events, `dispose:${TINY}`, `create:${MEDIUM}`);
    assert.equal(runtime.state(TINY).phase, "unloaded");
    assert.equal(runtime.state(MEDIUM).phase, "ready");
    await runtime.dispose();
  });
});

describe("OcrRuntime 失败重试", () => {
  it("下载失败与 Session 创建失败均保留错误，重试先清失败再成功", async () => {
    const { runtime, failOnce } = makeRuntime();
    failOnce.load.add(TINY);
    failOnce.create.add(TINY);

    await assert.rejects(runtime.select(TINY), /网络错误/);
    let st = runtime.state(TINY);
    assert.equal(st.phase, "failed");
    assert.match(st.error, /网络错误/);

    await assert.rejects(runtime.select(TINY), /Session 创建失败/);
    st = runtime.state(TINY);
    assert.equal(st.phase, "failed");
    assert.match(st.error, /Session 创建失败/);

    await runtime.select(TINY);
    assert.equal(runtime.state(TINY).phase, "ready");
    assert.equal(runtime.state(TINY).error, null);
    await runtime.dispose();
  });

  it("失败后错误保留在原模型卡上，可改选其他模型，也可重试", async () => {
    const { runtime, failOnce } = makeRuntime();
    failOnce.create.add(TINY);
    await assert.rejects(runtime.select(TINY));

    await runtime.select(SMALL);
    assert.equal(runtime.selectedId(), SMALL);
    assert.equal(runtime.state(SMALL).phase, "ready");
    assert.equal(runtime.state(TINY).phase, "failed");
    assert.match(runtime.state(TINY).error, /Session 创建失败/);

    await runtime.select(TINY);
    assert.equal(runtime.state(TINY).phase, "ready");
    assert.equal(runtime.state(TINY).error, null);
    await runtime.dispose();
  });
});

describe("OcrRuntime 运行期收口", () => {
  it("run 固定当前 Pipeline；运行期间拒绝切换与并发 run", async () => {
    const { runtime, gates, events } = makeRuntime();
    gates.run = deferred();
    await runtime.select(TINY);

    const runPromise = runtime.run(FAKE_IMAGE);
    await new Promise((r) => setImmediate(r));
    assert.equal(runtime.isBusy(), true);

    await assert.rejects(runtime.select(SMALL), RuntimeBusyError);
    await assert.rejects(runtime.run(FAKE_IMAGE), RuntimeBusyError);
    assert.equal(runtime.selectedId(), TINY);
    assert.equal(runtime.state(TINY).phase, "ready");

    gates.run.resolve();
    const out = await runPromise;
    assert.equal(out.backend, `fake-${TINY}`);
    assert.equal(runtime.isBusy(), false);
    assert.ok(!events.some((e) => e.startsWith("dispose:")));
    await runtime.dispose();
  });

  it("未选择/未就绪时 run 直接失败", async () => {
    const { runtime } = makeRuntime();
    await assert.rejects(runtime.run(FAKE_IMAGE), /尚未选择模型/);
    await runtime.dispose();
  });
});

describe("OcrRuntime dispose 收口", () => {
  it("加载中 dispose：pending load 不复活，之后 select/run 拒绝", async () => {
    const { runtime, gates, events } = makeRuntime();
    gates.load = deferred();
    const pick = runtime.select(TINY);
    const disposed = runtime.dispose();
    gates.load.resolve();
    await assert.rejects(pick, RuntimeClosedError);
    await disposed;

    assert.ok(!events.some((e) => e.startsWith("create:")));
    assert.equal(runtime.state(TINY).phase, "unloaded");
    assert.equal(runtime.isClosed(), true);
    await assert.rejects(runtime.select(TINY), RuntimeClosedError);
    await assert.rejects(runtime.run(FAKE_IMAGE), RuntimeClosedError);
    await runtime.dispose();
  });

  it("Session 创建中 dispose：创建完成即销毁，不停留", async () => {
    const { runtime, gates, events } = makeRuntime();
    gates.create = deferred();
    const pick = runtime.select(TINY);
    await new Promise((r) => setImmediate(r));
    const disposed = runtime.dispose();
    gates.create.resolve();
    await assert.rejects(pick, RuntimeClosedError);
    await disposed;
    assertBefore(events, `create:${TINY}`, `dispose:${TINY}`);
    assert.equal(runtime.state(TINY).phase, "unloaded");
  });

  it("run 进行中 dispose：等待运行收口后释放 Session", async () => {
    const { runtime, gates } = makeRuntime();
    gates.run = deferred();
    await runtime.select(TINY);
    const runPromise = runtime.run(FAKE_IMAGE);
    await new Promise((r) => setImmediate(r));

    let disposeDone = false;
    const disposed = runtime.dispose().then(() => {
      disposeDone = true;
    });
    await new Promise((r) => setImmediate(r));
    assert.equal(disposeDone, false, "run 未收口前 dispose 不应完成");

    gates.run.resolve();
    await runPromise;
    await disposed;
    assert.equal(runtime.state(TINY).phase, "unloaded");
    assert.equal(runtime.isClosed(), true);
  });
});
