import assert from "node:assert/strict";
import { it } from "node:test";
import { ToolWorkerClient } from "../lib/worker-client.ts";
import { restoreError, serializeError } from "../lib/worker-protocol.ts";

const tick = () => new Promise((resolve) => setImmediate(resolve));

class FakeWorker {
  onmessage = null;
  onerror = null;
  onmessageerror = null;
  messages = [];
  terminated = false;
  constructor(handle = () => {}) { this.handle = handle; }
  postMessage(request, transfer = []) {
    this.messages.push({ ...request, transfer });
    if (request.method === "init") {
      queueMicrotask(() => this.reply(request.id));
    } else this.handle(request, this);
  }
  reply(id, value) { this.onmessage?.({ data: { kind: "result", id, value } }); }
  emit(id, name, payload) { this.onmessage?.({ data: { kind: "event", id, name, payload } }); }
  terminate() { this.terminated = true; }
}

function client(factory, overrides = {}) {
  return new ToolWorkerClient({
    createWorker: factory,
    init: { config: "test" },
    restoreError: (value) => restoreError(value, {}),
    disposeTimeoutMs: 10,
    ...overrides,
  });
}

it("starts lazily, initializes once and routes per-task progress/results", async () => {
  let starts = 0;
  const progress = [];
  const worker = new FakeWorker((request, self) => {
    self.emit(request.id, "run-progress", { pct: 50 });
    self.reply(request.id, request.payload);
  });
  const rpc = client(() => { starts++; return worker; });
  assert.equal(starts, 0);
  assert.deepEqual(await rpc.call("run", { image: 1 }, [], (event) => progress.push(event.payload)), { image: 1 });
  await rpc.call("run", { image: 2 });
  assert.equal(starts, 1);
  assert.deepEqual(worker.messages.map((request) => request.method), ["init", "run", "run"]);
  assert.deepEqual(progress, [{ pct: 50 }]);
  await rpc.dispose();
});

it("disposal rejects pending work, ignores late events and bounds unresponsive cleanup", async () => {
  const events = [];
  const worker = new FakeWorker();
  const rpc = client(() => worker, { onEvent: (event) => events.push(event) });
  const running = rpc.call("run");
  const rejected = assert.rejects(running, { name: "AbortError" });
  await tick();
  const runId = worker.messages.find((request) => request.method === "run").id;
  const closing = rpc.dispose();
  assert.equal(rpc.dispose(), closing);
  worker.emit(runId, "run-progress", { pct: 100 });
  worker.reply(runId, "stale result");
  await Promise.all([rejected, closing]);
  assert.equal(worker.terminated, true);
  assert.deepEqual(events, []);
  await assert.rejects(rpc.call("run"), { name: "AbortError" });
});

it("starting a new heavy tool terminates its predecessor before creating a worker", async () => {
  const firstWorker = new FakeWorker((request, self) => {
    if (request.method !== "dispose") self.reply(request.id);
  });
  const first = client(() => firstWorker);
  await first.call("load");
  const secondWorker = new FakeWorker((request, self) => self.reply(request.id));
  const second = client(() => {
    assert.equal(firstWorker.terminated, true);
    return secondWorker;
  });
  await second.call("load");
  await assert.rejects(first.call("run"), { name: "AbortError" });
  await second.dispose();
});

it("rapid tool switches cannot resurrect an intermediate worker", async () => {
  const firstWorker = new FakeWorker((request, self) => {
    if (request.method !== "dispose") self.reply(request.id);
  });
  const first = client(() => firstWorker);
  await first.call("load");
  let intermediateStarts = 0;
  const intermediate = client(() => { intermediateStarts++; return new FakeWorker(); });
  const stale = intermediate.call("load");
  const staleRejected = assert.rejects(stale, { name: "AbortError" });
  const last = client(() => {
    assert.equal(firstWorker.terminated, true);
    return new FakeWorker((request, self) => self.reply(request.id));
  });
  await last.call("load");
  await staleRejected;
  assert.equal(intermediateStarts, 0);
  await last.dispose();
});

it("a crashed worker rejects callers and the next request starts a fresh engine", async () => {
  const workers = [];
  const failures = [];
  const rpc = client(() => {
    const worker = new FakeWorker((request, self) => {
      if (workers.length > 1) self.reply(request.id, "recovered");
    });
    workers.push(worker);
    return worker;
  }, { onFailure: (error) => failures.push(error.message) });
  const run = rpc.call("run");
  const rejected = assert.rejects(run, /worker crashed/);
  await tick();
  workers[0].onerror({ message: "worker crashed", preventDefault() {} });
  await rejected;
  assert.equal(await rpc.call("load"), "recovered");
  assert.equal(workers.length, 2);
  assert.equal(workers[0].terminated, true);
  assert.deepEqual(failures, ["worker crashed"]);
  await rpc.dispose();
});

for (const failure of ["crash", "init rejection"]) {
  it(`a synchronous retry after ${failure} cannot be cancelled by the older startup`, async () => {
    let starts = 0;
    let retry;
    const rpc = client(() => {
      starts++;
      const worker = new FakeWorker((request, self) => self.reply(request.id, "recovered"));
      if (starts === 1) {
        worker.postMessage = (request) => {
          queueMicrotask(() => {
            if (failure === "crash") {
              worker.onerror({ message: "init failed", preventDefault() {} });
            } else {
              worker.onmessage({ data: { kind: "error", id: request.id, error: { name: "Error", message: "init failed" } } });
            }
          });
        };
      }
      return worker;
    }, { onFailure: () => { retry = rpc.call("load"); } });
    await assert.rejects(rpc.call("load"), /init failed/);
    assert.equal(await retry, "recovered");
    assert.equal(starts, 2);
    await rpc.dispose();
  });
}

it("custom error types survive the protocol without cloning implementation objects", () => {
  class BackendError extends Error {}
  const original = new BackendError("GPU unavailable");
  original.name = "BackendError";
  original.backend = "webgpu";
  const restored = restoreError(serializeError(original), { BackendError: BackendError.prototype });
  assert.ok(restored instanceof BackendError);
  assert.equal(restored.message, "GPU unavailable");
  assert.equal(restored.backend, "webgpu");
});
