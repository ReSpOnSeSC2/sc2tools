"use client";

/**
 * React hook owning the optimizer Web Worker lifecycle: lazy
 * creation, run/cancel, progress state, and cleanup on unmount.
 *
 * Falls back to running the (chunked, yielding) optimizer on the
 * main thread when Workers are unavailable — same API either way.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { optimize } from "../search/optimize";
import type {
  OptimizeProgress,
  OptimizeRequest,
  OptimizeResult,
} from "../types";
import type { FromWorkerMessage, ToWorkerMessage } from "./protocol";

export type OptimizerStatus = "idle" | "running" | "done" | "cancelled" | "error";

export interface OptimizerWorkerApi {
  status: OptimizerStatus;
  progress: OptimizeProgress | null;
  result: OptimizeResult | null;
  error: string | null;
  run: (request: OptimizeRequest) => void;
  cancel: () => void;
}

export function useOptimizerWorker(): OptimizerWorkerApi {
  const workerRef = useRef<Worker | null>(null);
  const runIdRef = useRef<string>("");
  const cancelledRef = useRef(false);
  const [status, setStatus] = useState<OptimizerStatus>("idle");
  const [progress, setProgress] = useState<OptimizeProgress | null>(null);
  const [result, setResult] = useState<OptimizeResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  const ensureWorker = useCallback((): Worker | null => {
    if (typeof window === "undefined" || typeof Worker === "undefined") {
      return null;
    }
    if (workerRef.current) return workerRef.current;
    const worker = new Worker(
      new URL("./optimizer.worker.ts", import.meta.url),
    );
    worker.onmessage = (event: MessageEvent<FromWorkerMessage>) => {
      const message = event.data;
      if (!message || message.runId !== runIdRef.current) return;
      if (message.type === "progress") {
        setProgress(message.progress);
      } else if (message.type === "done") {
        setResult(message.result);
        setStatus("done");
      } else if (message.type === "cancelled") {
        setResult(message.result);
        setStatus("cancelled");
      } else if (message.type === "error") {
        setError(message.message);
        setStatus("error");
      }
    };
    worker.onerror = () => {
      setError("Optimizer worker crashed.");
      setStatus("error");
    };
    workerRef.current = worker;
    return worker;
  }, []);

  const run = useCallback(
    (request: OptimizeRequest) => {
      const runId = `run-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      runIdRef.current = runId;
      cancelledRef.current = false;
      setStatus("running");
      setProgress(null);
      setResult(null);
      setError(null);

      const worker = ensureWorker();
      if (worker) {
        const message: ToWorkerMessage = { type: "run", runId, request };
        worker.postMessage(message);
        return;
      }
      // Main-thread fallback (no Worker support): same engine, the
      // per-generation yield keeps the UI responsive enough.
      optimize(request, {
        onProgress: (p) => {
          if (runIdRef.current === runId) setProgress(p);
        },
        shouldCancel: () => cancelledRef.current,
        yieldBetweenGenerations: () =>
          new Promise<void>((resolve) => setTimeout(resolve, 0)),
      })
        .then((res) => {
          if (runIdRef.current !== runId) return;
          setResult(res);
          setStatus(cancelledRef.current ? "cancelled" : "done");
        })
        .catch((err: unknown) => {
          if (runIdRef.current !== runId) return;
          setError(err instanceof Error ? err.message : String(err));
          setStatus("error");
        });
    },
    [ensureWorker],
  );

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    const worker = workerRef.current;
    if (worker && runIdRef.current) {
      const message: ToWorkerMessage = {
        type: "cancel",
        runId: runIdRef.current,
      };
      worker.postMessage(message);
    }
  }, []);

  return { status, progress, result, error, run, cancel };
}
