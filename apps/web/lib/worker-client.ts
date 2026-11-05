import type { SerializedError, WorkerEvent, WorkerReply, WorkerRequest } from "./worker-protocol.ts";

interface PendingRequest {
  resolve(value: unknown): void;
  reject(reason: unknown): void;
  onEvent?: (event: WorkerEvent) => void;
}

interface WorkerClientOptions {
  createWorker(): Worker;
  init: unknown;
  restoreError(error: SerializedError): Error;
  onEvent?: (event: WorkerEvent) => void;
  onFailure?: (error: unknown) => void;
  disposeTimeoutMs?: number;
}

// The site has one active heavy tool. Navigation renders immediately; only starting
// another inference worker waits for the previous worker's bounded cleanup.
const activeSlot: { client: ToolWorkerClient | null } = { client: null };
let retirement: Promise<void> = Promise.resolve();

function closedError(): DOMException {
  return new DOMException("工具任务已取消或关闭", "AbortError");
}

export class ToolWorkerClient {
  private worker: Worker | null = null;
  private starting: Promise<void> | null = null;
  private closed = false;
  private sequence = 0;
  private startAttempt = 0;
  private pending = new Map<number, PendingRequest>();
  private disposing: Promise<void> | null = null;
  private readonly options: WorkerClientOptions;

  constructor(options: WorkerClientOptions) {
    this.options = options;
  }

  async call<T>(
    method: WorkerRequest["method"],
    payload?: unknown,
    transfer: Transferable[] = [],
    onEvent?: (event: WorkerEvent) => void,
  ): Promise<T> {
    if (this.closed) throw closedError();
    await this.start();
    if (this.closed) throw closedError();
    return this.send(method, payload, transfer, onEvent) as Promise<T>;
  }

  private start(): Promise<void> {
    if (this.starting) return this.starting;
    const attempt = ++this.startAttempt;
    const start = async () => {
      const previous = activeSlot.client;
      activeSlot.client = this;
      const cleanup = previous && previous !== this ? previous.dispose() : Promise.resolve();
      // A -> B -> C can happen while A is still shutting down. C must also wait
      // for A, even when B never created a worker of its own.
      retirement = Promise.allSettled([retirement, cleanup]).then(() => undefined);
      await retirement;
      if (this.closed || activeSlot.client !== this || attempt !== this.startAttempt) throw closedError();

      const worker = this.options.createWorker();
      this.worker = worker;
      worker.onmessage = (event: MessageEvent<WorkerReply>) => {
        if (this.worker !== worker) return;
        const reply = event.data;
        if (reply.kind === "event") {
          if (!this.closed) {
            this.options.onEvent?.(reply);
            this.pending.get(reply.id)?.onEvent?.(reply);
          }
          return;
        }
        const request = this.pending.get(reply.id);
        if (!request) return;
        this.pending.delete(reply.id);
        if (reply.kind === "error") request.reject(this.options.restoreError(reply.error));
        else request.resolve(reply.value);
      };
      worker.onerror = (event) => {
        event.preventDefault();
        this.fail(worker, new Error(event.message || "后台处理进程启动失败"));
      };
      worker.onmessageerror = () => this.fail(worker, new Error("后台处理结果传输失败"));
      await this.send("init", this.options.init);
    };
    this.starting = start().catch((error) => {
      // onFailure may immediately start a retry. An older init rejection must
      // not clear that attempt or terminate the replacement worker.
      if (attempt === this.startAttempt) {
        this.starting = null;
        if (this.worker) this.fail(this.worker, error);
        if (attempt === this.startAttempt && activeSlot.client === this) activeSlot.client = null;
      }
      throw error;
    });
    return this.starting;
  }

  private send(
    method: WorkerRequest["method"],
    payload?: unknown,
    transfer: Transferable[] = [],
    onEvent?: (event: WorkerEvent) => void,
  ): Promise<unknown> {
    const worker = this.worker;
    if (!worker) return Promise.reject(closedError());
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onEvent });
      try {
        worker.postMessage({ id, method, payload } satisfies WorkerRequest, transfer);
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private rejectPending(reason: unknown): void {
    for (const request of this.pending.values()) request.reject(reason);
    this.pending.clear();
  }

  private fail(worker: Worker, reason: unknown): void {
    if (this.worker !== worker) return;
    worker.terminate();
    this.worker = null;
    this.starting = null;
    this.rejectPending(reason);
    if (!this.closed) this.options.onFailure?.(reason);
  }

  dispose(): Promise<void> {
    if (this.disposing) return this.disposing;
    this.closed = true;
    this.rejectPending(closedError());
    const worker = this.worker;
    if (!worker) {
      if (activeSlot.client === this) activeSlot.client = null;
      return (this.disposing = Promise.resolve());
    }

    // Give abort/release a chance to finish; an uninterruptible inference cannot
    // keep a departing page or the next tool alive indefinitely.
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.options.disposeTimeoutMs ?? 1000);
    });
    this.disposing = Promise.race([
      this.send("dispose").then(() => undefined, () => undefined),
      timeout,
    ]).finally(() => {
      clearTimeout(timer);
      worker.terminate();
      if (this.worker === worker) this.worker = null;
      this.starting = null;
      this.rejectPending(closedError());
      if (activeSlot.client === this) activeSlot.client = null;
    });
    return this.disposing;
  }
}
