// Only serializable messages cross the worker boundary. Domain results keep their own types.
export interface WorkerRequest {
  id: number;
  method: "init" | "select" | "load" | "run" | "dispose";
  payload?: unknown;
}

export interface SerializedError {
  name: string;
  message: string;
  backend?: string;
}

export interface WorkerEvent {
  kind: "event";
  id: number;
  name: "state" | "load-progress" | "run-progress";
  payload: unknown;
}

export type WorkerReply =
  | WorkerEvent
  | { kind: "result"; id: number; value: unknown }
  | { kind: "error"; id: number; error: SerializedError };

export interface EngineDeployment {
  assetBaseURL: string;
  wasmBaseURL: string;
}

export function serializeError(value: unknown): SerializedError {
  const error = value instanceof Error ? value : new Error(String(value));
  const backend = "backend" in error ? error.backend : undefined;
  return {
    name: error.name,
    message: error.message,
    ...(typeof backend === "string" ? { backend } : {}),
  };
}

export function restoreError(
  value: SerializedError,
  prototypes: Readonly<Record<string, object>>,
): Error {
  const error = new Error(value.message);
  // Use an explicit allowlist; structured cloning does not preserve custom Error prototypes.
  if (Object.hasOwn(prototypes, value.name)) {
    Object.setPrototypeOf(error, prototypes[value.name]);
  }
  error.name = value.name;
  if (value.backend) Object.assign(error, { backend: value.backend });
  return error;
}
