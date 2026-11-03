import { ExportDownloadError } from "../exportErrors";
const defaultFactory = () => new Worker(new URL("./zipWorker.ts", import.meta.url), { type: "module" });

/** Additional owned observers never replace D1 handlers and never inspect/log raw native errors. */
export function packWorkerOwner(job: string, failed: () => void, create = defaultFactory) {
  let worker: Worker | null = null, retired = false, notified = false, attempted = false;
  const notify = () => { if (retired || notified) return; notified = true; try { failed(); } catch { /* Observer failure cannot strand D1 cleanup. */ } };
  const nativeError = () => notify();
  const message = (event: MessageEvent<unknown>) => {
    const value = event.data;
    if (value && typeof value === "object") {
      const packet = value as Record<string, unknown>;
      if (packet.job === job && packet.type === "settled" && (packet.status === "failed" || packet.status === "aborted")) notify();
    }
  };
  const retire = () => {
    if (retired) return; retired = true;
    worker?.removeEventListener("error", nativeError); worker?.removeEventListener("messageerror", nativeError); worker?.removeEventListener("message", message);
  };
  return {
    factory: () => {
      if (attempted || retired) throw new ExportDownloadError("failed"); attempted = true;
      try {
        worker = create();
        worker.addEventListener("error", nativeError); worker.addEventListener("messageerror", nativeError); worker.addEventListener("message", message);
        return worker;
      } catch {
        notify(); retire();
        try { worker?.terminate(); } catch { /* Owned request only; no observable thread-complete promise. */ }
        throw new ExportDownloadError("failed");
      }
    }, retire,
  };
}
