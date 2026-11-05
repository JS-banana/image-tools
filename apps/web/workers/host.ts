import { serializeError, type WorkerEvent, type WorkerReply, type WorkerRequest } from "../lib/worker-protocol.ts";

interface WorkerScope {
  postMessage(message: WorkerReply, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
}

const scope = globalThis as unknown as WorkerScope;

export function emit(id: number, name: WorkerEvent["name"], payload: unknown): void {
  scope.postMessage({ kind: "event", id, name, payload });
}

export function installWorker(
  handle: (request: WorkerRequest) => Promise<{ value?: unknown; transfer?: Transferable[] }>,
): void {
  scope.onmessage = ({ data: request }) => {
    void handle(request).then(
      ({ value, transfer }) => scope.postMessage({ kind: "result", id: request.id, value }, transfer),
      (error) => scope.postMessage({ kind: "error", id: request.id, error: serializeError(error) }),
    );
  };
}

export interface WorkerPixels {
  data: Uint8ClampedArray<ArrayBuffer>;
  width: number;
  height: number;
}
