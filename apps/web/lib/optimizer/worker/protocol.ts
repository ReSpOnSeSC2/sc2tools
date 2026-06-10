/**
 * Message protocol between the UI and the optimizer Web Worker.
 * Everything crossing the boundary is a structured-clone-safe POJO.
 */
import type {
  OptimizeProgress,
  OptimizeRequest,
  OptimizeResult,
} from "../types";

export type ToWorkerMessage =
  | { type: "run"; runId: string; request: OptimizeRequest }
  | { type: "cancel"; runId: string };

export type FromWorkerMessage =
  | { type: "progress"; runId: string; progress: OptimizeProgress }
  | { type: "done"; runId: string; result: OptimizeResult }
  | { type: "cancelled"; runId: string; result: OptimizeResult }
  | { type: "error"; runId: string; message: string };

export function isToWorkerMessage(raw: unknown): raw is ToWorkerMessage {
  if (!raw || typeof raw !== "object") return false;
  const msg = raw as { type?: unknown; runId?: unknown };
  return (
    (msg.type === "run" || msg.type === "cancel") &&
    typeof msg.runId === "string"
  );
}
