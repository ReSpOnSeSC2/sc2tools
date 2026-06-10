/**
 * Optimizer Web Worker shell. Keep this file dependency-pure: no DOM,
 * no React, no Clerk — only the engine modules — so webpack bundles a
 * lean worker chunk and the engine stays testable outside a Worker.
 */
import { optimize } from "../search/optimize";
import {
  isToWorkerMessage,
  type FromWorkerMessage,
} from "./protocol";

const scope = self as unknown as {
  postMessage: (msg: FromWorkerMessage) => void;
  onmessage: ((event: MessageEvent) => void) | null;
};

let activeRunId: string | null = null;
let cancelRequested = false;

scope.onmessage = (event: MessageEvent) => {
  const message: unknown = event.data;
  if (!isToWorkerMessage(message)) return;

  if (message.type === "cancel") {
    if (message.runId === activeRunId) cancelRequested = true;
    return;
  }

  const { runId, request } = message;
  activeRunId = runId;
  cancelRequested = false;

  optimize(request, {
    onProgress: (progress) => {
      scope.postMessage({ type: "progress", runId, progress });
    },
    shouldCancel: () => cancelRequested,
    yieldBetweenGenerations: () =>
      new Promise<void>((resolve) => setTimeout(resolve, 0)),
  })
    .then((result) => {
      if (activeRunId !== runId) return;
      scope.postMessage(
        cancelRequested
          ? { type: "cancelled", runId, result }
          : { type: "done", runId, result },
      );
    })
    .catch((error: unknown) => {
      if (activeRunId !== runId) return;
      scope.postMessage({
        type: "error",
        runId,
        message: error instanceof Error ? error.message : String(error),
      });
    });
};
