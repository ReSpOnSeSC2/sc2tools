import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { webcrypto } from "node:crypto";
import { useReplayPackDownload } from "./useReplayPackDownload";
import { exportBusy } from "../exportAdmission";
import { PackTestWorker, bytesResponse, deferred, envelope, heldResponse, jsonResponse, outputSink, readyRow, testNow, ticks } from "./replayPackTestFixtures";

vi.hoisted(async () => {
  const codecs = await import("node:util");
  class BrowserTextEncoder extends codecs.TextEncoder {
    encode(input?: string) {
      const encoded = super.encode(input), received = new Uint8Array(encoded.byteLength); received.set(encoded); return received;
    }
  }
  Object.assign(globalThis, { TextEncoder: BrowserTextEncoder, TextDecoder: codecs.TextDecoder });
});
const auth = vi.hoisted(() => ({ owner: "clerk-a" as string | null, token: vi.fn(async (): Promise<string | null> => "synthetic") }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ userId: auth.owner, isLoaded: true, isSignedIn: !!auth.owner, getToken: auth.token }) }));
beforeEach(() => { vi.stubGlobal("crypto", webcrypto); vi.spyOn(Date, "now").mockReturnValue(testNow); });
afterEach(() => {
  try { cleanup(); expect(exportBusy()).toBe(false); }
  finally { vi.restoreAllMocks(); vi.unstubAllGlobals(); auth.owner = "clerk-a"; auth.token.mockReset().mockResolvedValue("synthetic"); }
});

function setup() {
  expect(new TextEncoder().encode("fixture realm")).toBeInstanceOf(Uint8Array);
  const workers: PackTestWorker[] = [], output = outputSink();
  vi.stubGlobal("Worker", class { constructor() { const worker = new PackTestWorker(); workers.push(worker); return worker; } });
  const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => init?.method === "POST" ? jsonResponse(envelope([readyRow("one")])) : bytesResponse());
  const picker = vi.fn(async () => ({ createWritable: async () => output }));
  vi.stubGlobal("fetch", fetch); vi.stubGlobal("showSaveFilePicker", picker);
  const hook = renderHook(({ selection }) => useReplayPackDownload(selection), { initialProps: { selection: "query-a:selected-one:revision-1" } });
  return { ...hook, workers, output, fetch, picker };
}

describe("replay pack owner/query/selection lifetimes", () => {
  it.each([
    { first: "worker", kind: "error" }, { first: "worker", kind: "messageerror" },
    { first: "cancel", kind: "error" }, { first: "cancel", kind: "messageerror" },
  ] as const)("$first first then $kind/Cancel retains its fixed cause through the outer race and actual held cleanup", async ({ first, kind }) => {
    const job = setup(), reader = heldResponse(), abort = deferred();
    job.fetch.mockImplementationOnce(async () => jsonResponse(envelope([readyRow("one")]))).mockImplementationOnce(async () => reader.response);
    job.output.abort.mockImplementationOnce(() => abort.promise);
    let work!: Promise<boolean>; act(() => { work = job.result.current.run([{ gameId: "one" }], "game-id"); });
    try {
      await waitFor(() => expect(reader.reader.read).toHaveBeenCalledOnce());
      if (first === "worker") act(() => { job.workers[0].crash(kind); });
      await act(async () => { job.result.current.cancel(); expect(await work).toBe(false); });
      if (first === "cancel") act(() => { job.workers[0].crash(kind); });
      await waitFor(() => { expect(reader.reader.cancel).toHaveBeenCalledOnce(); expect(job.output.abort).toHaveBeenCalledOnce(); });
      expect(job.result.current.feedback?.message).toBe(first === "worker" ? "Couldn't complete the export. Please try again." : "Export cancelled.");
      expect(job.result.current.feedback?.result).toBeUndefined(); expect(job.result.current.busy).toBe(true); expect(job.output.close).not.toHaveBeenCalled();
      await act(async () => { reader.cancelled.resolve(); await ticks(); }); expect(exportBusy()).toBe(true);
      await act(async () => { reader.read.resolve({ done: true, value: undefined }); await ticks(); }); expect(exportBusy()).toBe(true);
      auth.owner = "clerk-b"; job.rerender({ selection: "query-a:selected-one:revision-1" });
      auth.owner = "clerk-a"; job.rerender({ selection: "query-a:selected-one:revision-1" }); expect(job.result.current.feedback).toBeNull();
      await act(async () => { abort.resolve(); }); await waitFor(() => expect(job.result.current.busy).toBe(false));
      expect(job.result.current.feedback).toBeNull(); expect(job.output.abort).toHaveBeenCalledOnce(); expect(job.output.close).not.toHaveBeenCalled();
      expect(job.fetch).toHaveBeenCalledTimes(2); expect(job.workers[0].listenerCount()).toBe(0);
    } finally { job.result.current.cancel(); reader.read.resolve({ done: true, value: undefined }); reader.cancelled.resolve(); abort.resolve(); await work; await waitFor(() => expect(exportBusy()).toBe(false)); }
  });

  it.each(["picker", "jwt", "api", "read", "write", "close"] as const)("A→B→A during actual held %s keeps admission, suppresses stale feedback and never revives old work", async phase => {
    const job = setup(), entered = vi.fn(), release = deferred(), reader = heldResponse();
    if (phase === "picker") job.picker.mockImplementationOnce(async () => { entered(); await release.promise; return { createWritable: async () => job.output }; });
    if (phase === "jwt") auth.token.mockImplementationOnce(async () => { entered(); await release.promise; return "retired-private-token"; });
    if (phase === "api") job.fetch.mockImplementationOnce(async () => { entered(); await release.promise; return jsonResponse(envelope([readyRow("one")])); });
    if (phase === "read") job.fetch.mockImplementationOnce(async () => jsonResponse(envelope([readyRow("one")]))).mockImplementationOnce(async () => { entered(); return reader.response; });
    if (phase === "write") job.output.write.mockImplementationOnce(async () => { entered(); await release.promise; });
    if (phase === "close") job.output.close.mockImplementationOnce(async () => { entered(); await release.promise; });
    let old!: Promise<boolean>; act(() => { old = job.result.current.run([{ gameId: "one" }], "game-id"); });
    try {
      await waitFor(() => expect(entered).toHaveBeenCalledOnce()); if (phase === "read") await waitFor(() => expect(reader.reader.read).toHaveBeenCalledOnce());
      auth.owner = "clerk-b"; job.rerender({ selection: "query-a:selected-one:revision-1" }); expect(job.result.current.feedback).toBeNull();
      auth.owner = "clerk-a"; job.rerender({ selection: "query-a:selected-one:revision-1" });
      await act(async () => { expect(await old).toBe(false); }); expect(job.result.current.busy).toBe(true);
      await act(async () => { expect(await job.result.current.run([{ gameId: "one" }], "game-id")).toBe(false); });
      expect(job.picker).toHaveBeenCalledOnce(); expect(job.result.current.feedback).toBeNull();
      if (phase === "picker" || phase === "jwt") expect(job.fetch).not.toHaveBeenCalled();
      await act(async () => { release.resolve(); reader.read.resolve({ done: true, value: undefined }); reader.cancelled.resolve(); });
      await waitFor(() => expect(job.result.current.busy).toBe(false)); expect(job.result.current.feedback).toBeNull();
      if (phase !== "picker") expect(job.output.abort).toHaveBeenCalledOnce();
      await act(async () => { expect(await job.result.current.run([{ gameId: "one" }], "game-id")).toBe(true); });
      expect(job.result.current.feedback?.message).toBe("Replay pack saved."); expect(job.result.current.feedback?.result).toMatchObject({ saved: 1 });
    } finally { job.result.current.cancel(); release.resolve(); reader.read.resolve({ done: true, value: undefined }); reader.cancelled.resolve(); await old; await waitFor(() => expect(exportBusy()).toBe(false)); }
  });

  it("query/selection A→B→A has a fresh lifetime, and cancel remains blocked behind actual output cleanup", async () => {
    const job = setup(), entered = vi.fn(), read = deferred(), abort = deferred();
    job.output.write.mockImplementationOnce(async () => { entered(); await read.promise; }); job.output.abort.mockImplementationOnce(() => abort.promise);
    let work!: Promise<boolean>; act(() => { work = job.result.current.run([{ gameId: "one" }], "game-id"); });
    try {
      await waitFor(() => expect(entered).toHaveBeenCalledOnce()); job.rerender({ selection: "query-b:selected-two:revision-2" }); job.rerender({ selection: "query-a:selected-one:revision-1" });
      await act(async () => { expect(await work).toBe(false); }); await waitFor(() => expect(job.output.abort).toHaveBeenCalledOnce());
      expect(job.result.current.feedback).toBeNull(); expect(job.result.current.busy).toBe(true);
      await act(async () => { job.result.current.cancel(); job.result.current.clear(); read.resolve(); await ticks(); }); expect(exportBusy()).toBe(true);
      await act(async () => { abort.resolve(); }); await waitFor(() => expect(job.result.current.busy).toBe(false)); expect(job.result.current.feedback).toBeNull();
    } finally { job.result.current.cancel(); read.resolve(); abort.resolve(); await work; await waitFor(() => expect(exportBusy()).toBe(false)); }
  });

  it("repeated click preserves the active cancel controller and fixed result feedback is owner fenced", async () => {
    const job = setup(), jwt = deferred<string | null>(); auth.token.mockImplementationOnce(() => jwt.promise);
    let work!: Promise<boolean>; act(() => { work = job.result.current.run([{ gameId: "one" }], "game-id"); });
    try {
      await waitFor(() => expect(auth.token).toHaveBeenCalledOnce());
      await act(async () => { expect(await job.result.current.run([{ gameId: "one" }], "game-id")).toBe(false); job.result.current.cancel(); expect(await work).toBe(false); });
      expect(job.result.current.feedback?.message).toBe("Export cancelled."); expect(exportBusy()).toBe(true); expect(job.picker).toHaveBeenCalledOnce();
      await act(async () => { jwt.resolve("retired"); }); await waitFor(() => expect(job.result.current.busy).toBe(false)); expect(job.fetch).not.toHaveBeenCalled();
      await act(async () => { expect(await job.result.current.run([{ gameId: "one" }], "game-id")).toBe(true); });
      expect(job.result.current.feedback?.progress).toBeUndefined(); expect(job.result.current.feedback?.result).toMatchObject({ saved: 1 });
      auth.owner = "clerk-b"; job.rerender({ selection: "query-a:selected-one:revision-1" }); expect(job.result.current.feedback).toBeNull();
      auth.owner = "clerk-a"; job.rerender({ selection: "query-a:selected-one:revision-1" }); expect(job.result.current.feedback).toBeNull();
      expect(JSON.stringify(job.result.current.feedback)).not.toContain("PRIVATE_");
    } finally { job.result.current.cancel(); jwt.resolve(null); await work; await waitFor(() => expect(exportBusy()).toBe(false)); }
  });
});
