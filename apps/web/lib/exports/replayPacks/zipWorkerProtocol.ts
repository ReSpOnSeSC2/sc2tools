import { StoreZip, ZIP_CHUNK_BYTES, REPLAY_BYTES, type ZipEntryKind } from "./zipStore";
import { MANIFEST_BYTES, README_BYTES } from "./packMetadata";

export const MAX_ZIP_BYTES = 100 * REPLAY_BYTES + MANIFEST_BYTES + README_BYTES + 102 * (30 + 240 + 46 + 240) + 22;
export const validZipJob = (job: unknown): job is string => typeof job === "string" && /^[A-Za-z0-9_-]{16,80}$/u.test(job);
export type ZipInput = { job: string; type: "start" | "abort" } | { job: string; type: "ack" | "nack"; seq: number }
  | { job: string; type: "entry"; id: number; name: string; kind: ZipEntryKind; bytes: ArrayBuffer }
  | { job: string; type: "finish"; id: number };
export type ZipOutput = { job: string; type: "ready" } | { job: string; type: "chunk"; seq: number; bytes: ArrayBuffer }
  | { job: string; type: "entry-done"; id: number } | { job: string; type: "settled"; status: "complete" | "aborted" | "failed" };
type Waiting = { seq: number; resolve: () => void; reject: (error: Error) => void };
type Notice<T> = T extends { job: string } ? Omit<T, "job"> : never;
const failure = () => new Error("zip_job_failed");

/** One dedicated job, one admitted input and one output waiting for ACK. No IO or background work lives here. */
export function createZipWorkerProtocol(send: (message: ZipOutput, transfer: Transferable[]) => void) {
  let job: string | null = null, active = false, ended = false, stopped: "aborted" | "failed" | null = null;
  let nextId = 1, nextSeq = 1, waiting: Waiting | null = null;
  const post = (message: Notice<ZipOutput>) => { if (!job) throw failure(); send({ ...message, job }, []); };
  const settle = (status: "complete" | "aborted" | "failed") => {
    if (ended || !job) return;
    ended = true; post({ type: "settled", status });
  };
  const stop = (status: "aborted" | "failed") => {
    stopped ||= status; zip.abort();
    const held = waiting; waiting = null; held?.reject(failure());
    if (!active) settle(stopped);
  };
  const zip = new StoreZip(chunk => {
    if (!job || stopped || ended || waiting || nextSeq > 10000 || chunk.byteLength < 1 || chunk.byteLength > ZIP_CHUNK_BYTES) return Promise.reject(failure());
    const seq = nextSeq++;
    return new Promise<void>((resolve, reject) => {
      waiting = { seq, resolve, reject };
      try { send({ job: job!, type: "chunk", seq, bytes: chunk.buffer as ArrayBuffer }, [chunk.buffer as ArrayBuffer]); }
      catch { waiting = null; reject(failure()); }
    });
  });

  async function receive(raw: unknown): Promise<void> {
    if (!raw || typeof raw !== "object") { if (job) stop("failed"); return; }
    const message = raw as Record<string, unknown>;
    if (!job) {
      if (stopped) return;
      if (message.type !== "start" || !validZipJob(message.job)) return;
      job = message.job; post({ type: "ready" }); return;
    }
    if (message.job !== job || ended) return;
    if (message.type === "abort") { stop("aborted"); return; }
    if (message.type === "ack" || message.type === "nack") {
      if (!waiting || message.seq !== waiting.seq) { stop("failed"); return; }
      const held = waiting; waiting = null;
      if (message.type === "nack") { held.reject(failure()); stop("failed"); }
      else held.resolve();
      return;
    }
    if (active || stopped || message.id !== nextId || !Number.isSafeInteger(message.id)) { stop("failed"); return; }
    if (message.type !== "entry" && message.type !== "finish") { stop("failed"); return; }
    nextId += 1; active = true;
    try {
      if (message.type === "finish") { await zip.finish(); if (!stopped) settle("complete"); }
      else {
        if (!(message.bytes instanceof ArrayBuffer) || typeof message.name !== "string"
          || (message.kind !== "replay" && message.kind !== "manifest" && message.kind !== "readme")) throw failure();
        await zip.add(message.name, new Uint8Array(message.bytes), message.kind);
        if (!stopped) post({ type: "entry-done", id: message.id as number });
      }
    } catch { stopped ||= "failed"; zip.abort(); }
    finally { active = false; if (stopped) settle(stopped); }
  }
  return { receive, fatal: () => {
    const unstarted = !job; stop("failed");
    // Before nonce admission no protocol response can be authenticated. A fixed
    // uncaught worker error reaches the owned main-thread Worker.onerror path.
    if (unstarted) throw failure();
  } };
}
