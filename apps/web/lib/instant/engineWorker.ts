/**
 * Web Worker entry of the in-browser replay engine (Instant Analysis).
 * Created only by `engineClient.ts`:
 *
 *   new Worker(new URL("./engineWorker.ts", import.meta.url), { type: "module" })
 *
 * (Next.js' webpack emits it as a classic worker; both kinds boot, see
 * `withImportScriptsHidden` in engineBoot.ts.)
 *
 * It boots the digest-verified, self-hosted Pyodide runtime plus the engine
 * bundle once (`engineBoot.ts`), installs the Python glue
 * (`enginePyGlue.ts`) and answers `WorkerRequest`s one at a time
 * (`engineWorkerHost.ts`). Replay bytes arrive and leave as transferred
 * `ArrayBuffer`s; nothing is logged.
 *
 * Example (main thread):
 *   worker.postMessage({ type: "boot", pointerUrl });
 *   // <- { type: "ready", info, heapBytes }
 */
import { bootEngine } from "./engineBoot";
import { createEngineRuntime } from "./enginePyGlue";
import { createEngineWorkerHost, type BootedRuntime } from "./engineWorkerHost";
import type { WorkerEvent, WorkerRequest } from "./protocol";

/** The parts of `DedicatedWorkerGlobalScope` this worker uses. */
interface EngineWorkerScope {
  postMessage(message: WorkerEvent, transfer: Transferable[]): void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
}

// The app tsconfig has no "webworker" lib (it conflicts with "dom"), so the
// worker global is typed through the local interface above. This module only
// ever runs as a dedicated worker, whose global has exactly that shape.
const scope = globalThis as unknown as EngineWorkerScope;

async function bootWorkerEngine(pointerUrl: string): Promise<BootedRuntime> {
  const { pyodide, info } = await bootEngine(pointerUrl);
  return { runtime: createEngineRuntime(pyodide), info };
}

const handle = createEngineWorkerHost(
  { post: (event, transfer) => scope.postMessage(event, transfer ?? []) },
  { boot: bootWorkerEngine },
);

scope.onmessage = (event) => {
  void handle(event.data);
};
