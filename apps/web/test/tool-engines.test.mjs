import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { it } from "node:test";
import { createRemoveBgClient } from "../lib/tool-engines.ts";

const catalog = JSON.parse(await readFile(new URL("../../../packages/remove-bg/models.json", import.meta.url), "utf8"));
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function withBrowser(run) {
  const originals = new Map(["window", "Worker", "fetch"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const workers = [];
  class FakeWorker {
    messages = [];
    terminated = false;
    constructor() { workers.push(this); }
    postMessage(request) {
      this.messages.push(request);
      if (request.method === "init" || request.method === "dispose") queueMicrotask(() => this.reply(request.id));
    }
    reply(id) { this.onmessage?.({ data: { kind: "result", id } }); }
    progress(id, pct) {
      this.onmessage?.({ data: { kind: "event", id, name: "load-progress", payload: { pct } } });
    }
    terminate() { this.terminated = true; }
  }
  Object.assign(globalThis, {
    window: { location: { origin: "https://example.test" } },
    Worker: FakeWorker,
    fetch: async () => Response.json(catalog),
  });
  try { await run(workers); }
  finally {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

it("a replacement image receives progress from the existing background-model download", async () => {
  await withBrowser(async (workers) => {
    const client = createRemoveBgClient({ modelId: "ben2-base-fp16", backend: "wasm" });
    const firstProgress = [];
    const replacementProgress = [];
    const first = client.load((progress) => firstProgress.push(progress.pct));
    await tick();
    const worker = workers[0];
    const request = worker.messages.find((message) => message.method === "load");
    worker.progress(request.id, 10);
    const replacement = client.load((progress) => replacementProgress.push(progress.pct));
    await tick();
    worker.progress(request.id, 80);
    worker.reply(request.id);
    await Promise.all([first, replacement]);
    assert.deepEqual(firstProgress, [10, 80]);
    assert.deepEqual(replacementProgress, [80]);
    assert.equal(worker.messages.filter((message) => message.method === "load").length, 1);
    await client.dispose();
    worker.progress(request.id, 100);
    assert.deepEqual(replacementProgress, [80]);
  });
});

it("all load callers reject on a worker failure and retry receives fresh progress", async () => {
  await withBrowser(async (workers) => {
    const client = createRemoveBgClient({ modelId: "ben2-base-fp16", backend: "wasm" });
    const first = assert.rejects(client.load(), /worker failed/);
    const second = assert.rejects(client.load(), /worker failed/);
    await tick();
    workers[0].onerror({ message: "worker failed", preventDefault() {} });
    await Promise.all([first, second]);
    const progress = [];
    const retry = client.load((value) => progress.push(value.pct));
    await tick();
    assert.equal(workers.length, 2);
    assert.equal(workers[0].terminated, true);
    const request = workers[1].messages.find((message) => message.method === "load");
    workers[1].progress(request.id, 100);
    workers[1].reply(request.id);
    await retry;
    assert.deepEqual(progress, [100]);
    await client.dispose();
  });
});
