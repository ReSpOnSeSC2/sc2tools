// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadReplayPack, type ReplayPackEnvironment } from "./downloadReplayPack";
import { startPackDestination } from "./packDestination";
import { exportBusy } from "../exportAdmission";
import { PackTestWorker, bytesResponse, deferred, envelope, heldResponse, jsonResponse, outputSink, readyRow, testJob, testNow, ticks } from "./replayPackTestFixtures";

const request = (ids = ["one"]) => ({ apiUrl: "https://api.example.test/v1/replays/download-batch", rows: ids.map(gameId => ({ gameId })), template: "game-id" as const });
function fixture() {
  const controller = new AbortController(), worker = new PackTestWorker(), output = outputSink(), saveBlob = vi.fn();
  const scope = { signal: controller.signal, assertCurrent: vi.fn(), token: vi.fn(async () => "synthetic") };
  const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => init?.method === "POST"
    ? jsonResponse(envelope((JSON.parse(String(init.body)).gameIds as string[]).map(id => readyRow(id)))) : bytesResponse());
  const environment: ReplayPackEnvironment = { fetch, picker: vi.fn(async () => ({ createWritable: async () => output })), saveBlob, workerFactory: worker.factory, job: () => testJob, now: () => testNow };
  return { controller, worker, output, scope, fetch, saveBlob, environment };
}
afterEach(() => { expect(exportBusy()).toBe(false); });

describe("actual replay pack cancellation and owned Worker failure", () => {
  it.each(["error", "messageerror"] as const)("idle Worker %s aborts all four readers promptly and retains first failure through actual read/cancel/output cleanup", async kind => {
    const job = fixture(), readers = Array.from({ length: 4 }, () => heldResponse()), outputAborted = deferred(); let next = 0, settled = false;
    job.output.abort.mockImplementation(() => outputAborted.promise);
    job.fetch.mockImplementation(async (_url, init) => init?.method === "POST"
      ? jsonResponse(envelope(["one", "two", "three", "four"].map(id => readyRow(id)))) : readers[next++].response);
    const onStop = vi.fn(() => { throw new Error("PRIVATE_OBSERVER_SENTINEL"); });
    const work = downloadReplayPack(request(["one", "two", "three", "four"]), { ...job.scope, onStop }, job.environment);
    const observed = work.then(() => { settled = true; return null; }, error => { settled = true; return error; });
    try {
      await Promise.all(readers.map(reader => reader.entered.promise)); job.worker.crash(kind);
      await vi.waitFor(() => { for (const reader of readers) expect(reader.reader.cancel).toHaveBeenCalledOnce(); expect(job.output.abort).toHaveBeenCalledOnce(); });
      job.controller.abort(); expect(exportBusy()).toBe(true); expect(settled).toBe(false); expect(job.worker.input.some(row => row.type === "entry")).toBe(false);
      for (const reader of readers) reader.cancelled.resolve(); await ticks(); expect(settled).toBe(false);
      for (const reader of readers) reader.read.resolve({ done: true, value: undefined }); await ticks(); expect(exportBusy()).toBe(true);
      outputAborted.resolve(); expect(await observed).toMatchObject({ code: "failed", message: "Couldn't complete the export. Please try again." });
      expect(onStop).toHaveBeenCalledOnce(); expect(onStop).toHaveBeenCalledWith("failed");
      expect(job.output.close).not.toHaveBeenCalled(); expect(job.saveBlob).not.toHaveBeenCalled(); expect(job.worker.listenerCount()).toBe(0);
      const replacement = fixture(); const replacementWork = downloadReplayPack(request(), replacement.scope, replacement.environment);
      job.worker.crash("error"); job.worker.inject({ type: "settled", job: testJob, status: "failed" });
      expect(await replacementWork).toMatchObject({ saved: 1 });
    } finally { for (const reader of readers) { reader.read.resolve({ done: true, value: undefined }); reader.cancelled.resolve(); } outputAborted.resolve(); await observed; }
  });

  it("held picker cancellation keeps reservation and starts no writable/JWT/worker/network after the picker resolves", async () => {
    const job = fixture(), picked = deferred<{ createWritable: () => Promise<ReturnType<typeof outputSink>> }>(), createWritable = vi.fn(async () => job.output);
    job.environment.picker = vi.fn(() => picked.promise);
    const work = downloadReplayPack(request(), job.scope, job.environment), observed = work.then(() => null, error => error);
    try {
      job.controller.abort(); await ticks(); expect(exportBusy()).toBe(true); expect(job.scope.token).not.toHaveBeenCalled();
      picked.resolve({ createWritable }); expect(await observed).toMatchObject({ code: "cancelled" });
      expect(createWritable).not.toHaveBeenCalled(); expect(job.worker.input).toHaveLength(0); expect(job.fetch).not.toHaveBeenCalled();
    } finally { picked.resolve({ createWritable }); await observed; }
  });

  it("held createWritable cancellation owns the late writer and joins its one actual abort", async () => {
    const job = fixture(), opened = deferred(), writer = deferred<ReturnType<typeof outputSink>>(), aborted = deferred();
    job.environment.picker = vi.fn(async () => ({ createWritable: () => { opened.resolve(); return writer.promise; } }));
    job.output.abort.mockImplementation(() => aborted.promise);
    const work = downloadReplayPack(request(), job.scope, job.environment), observed = work.then(() => null, error => error);
    try {
      await opened.promise; job.controller.abort(); writer.resolve(job.output); await vi.waitFor(() => expect(job.output.abort).toHaveBeenCalledOnce());
      expect(exportBusy()).toBe(true); expect(job.scope.token).not.toHaveBeenCalled(); expect(job.fetch).not.toHaveBeenCalled();
      aborted.resolve(); expect(await observed).toMatchObject({ code: "cancelled" }); expect(job.output.close).not.toHaveBeenCalled();
    } finally { writer.resolve(job.output); aborted.resolve(); await observed; }
  });

  it("held API response read/cancel and held output abort are joined before reservation release", async () => {
    const job = fixture(), body = heldResponse(), aborted = deferred();
    job.fetch.mockResolvedValue(body.response); job.output.abort.mockImplementation(() => aborted.promise);
    const work = downloadReplayPack(request(), job.scope, job.environment), observed = work.then(() => null, error => error);
    try {
      await body.entered.promise; job.controller.abort(); await vi.waitFor(() => expect(body.reader.cancel).toHaveBeenCalledOnce());
      body.read.resolve({ done: true, value: undefined }); await ticks(); expect(exportBusy()).toBe(true); expect(job.fetch).toHaveBeenCalledOnce();
      body.cancelled.resolve(); await vi.waitFor(() => expect(job.output.abort).toHaveBeenCalledOnce()); expect(exportBusy()).toBe(true);
      aborted.resolve(); expect(await observed).toMatchObject({ code: "cancelled" }); expect(job.worker.input.some(row => row.type === "entry")).toBe(false);
    } finally { body.read.resolve({ done: true, value: undefined }); body.cancelled.resolve(); aborted.resolve(); await observed; }
  });

  it.each(["write", "close"] as const)("cancel during held sink %s joins both that actual operation and abort with no successful publication", async operation => {
    const job = fixture(), entered = deferred(), outputDone = deferred(), abortDone = deferred(); let settled = false;
    job.output[operation].mockImplementationOnce(async () => { entered.resolve(); await outputDone.promise; }); job.output.abort.mockImplementation(() => abortDone.promise);
    const work = downloadReplayPack(request(), job.scope, job.environment), observed = work.then(() => { settled = true; return null; }, error => { settled = true; return error; });
    try {
      await entered.promise; job.controller.abort(); await vi.waitFor(() => expect(job.output.abort).toHaveBeenCalledOnce());
      abortDone.resolve(); await ticks(); expect(settled).toBe(false); expect(exportBusy()).toBe(true);
      outputDone.resolve(); expect(await observed).toMatchObject({ code: "cancelled" }); expect(job.saveBlob).not.toHaveBeenCalled();
      expect(job.output.abort).toHaveBeenCalledOnce();
    } finally { outputDone.resolve(); abortDone.resolve(); await observed; }
  });

  it("sink failure preserves a fixed failure and joins actual abort without a success artifact", async () => {
    const job = fixture(), abortDone = deferred(); job.output.write.mockRejectedValueOnce(new Error("PRIVATE_SIGNED_SENTINEL")); job.output.abort.mockImplementation(() => abortDone.promise);
    const work = downloadReplayPack(request(), job.scope, job.environment), observed = work.then(() => null, error => error);
    try {
      await vi.waitFor(() => expect(job.output.abort).toHaveBeenCalledOnce()); expect(exportBusy()).toBe(true); abortDone.resolve();
      expect(await observed).toMatchObject({ code: "failed", message: "Couldn't complete the export. Please try again." }); expect(job.saveBlob).not.toHaveBeenCalled();
    } finally { abortDone.resolve(); await observed; }
  });

  it("fallback publishes only a closed current archive and aborts literal128MiB overflow without an artifact", async () => {
    const saveBlob = vi.fn(), failed = vi.fn(), controller = new AbortController(), scope = { signal: controller.signal, assertCurrent: () => controller.signal.throwIfAborted() };
    const destination = await startPackDestination("safe.zip", { saveBlob }, scope, failed, () => {});
    expect(() => destination.publish()).toThrow(); expect(saveBlob).not.toHaveBeenCalled();
    const chunk = new Uint8Array(1024 ** 2);
    for (let index = 0; index < 128; index++) await destination.sink.write(chunk);
    await expect(destination.sink.write(new Uint8Array(1))).rejects.toMatchObject({ code: "too_large" });
    await destination.sink.abort(); expect(() => destination.publish()).toThrow(); expect(saveBlob).not.toHaveBeenCalled(); expect(failed).toHaveBeenCalledWith("too_large");
    const success = fixture(); success.environment.picker = undefined; await downloadReplayPack(request(), success.scope, success.environment);
    expect(success.saveBlob).toHaveBeenCalledOnce(); expect(success.saveBlob.mock.calls[0][0].type).toBe("application/zip");
    expect(success.saveBlob.mock.calls[0][0].size).toBeGreaterThan(4);
  });
});
