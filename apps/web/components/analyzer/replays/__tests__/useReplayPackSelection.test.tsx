import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useReplayPackSelection } from "../useReplayPackSelection";
import { deferred, heldResponse, jsonResponse, ticks } from "@/lib/exports/replayPacks/replayPackTestFixtures";

vi.hoisted(async () => { const codecs = await import("node:util"); Object.assign(globalThis, { TextEncoder: codecs.TextEncoder, TextDecoder: codecs.TextDecoder }); });
const auth = vi.hoisted(() => ({ token: vi.fn(async (): Promise<string | null> => "synthetic") }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ getToken: auth.token }) }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); auth.token.mockReset().mockResolvedValue("synthetic"); });
const initial = { owner: "owner-a", query: "sort=date_asc&search=Same", blocked: false };
function setup() {
  const fetch = vi.fn(async () => jsonResponse({ items: [] })); vi.stubGlobal("fetch", fetch);
  const hook = renderHook(({ owner, query, blocked }) => useReplayPackSelection(owner, query, blocked), { initialProps: initial });
  return { ...hook, fetch };
}

describe("atomic independent pack selection", () => {
  it("retains same-scope prior selection on failed/malformed matching, then replaces exactly with first100 and bounds individual additions", async () => {
    const job = setup(); act(() => job.result.current.toggle({ gameId: "kept", result: "Win" }));
    job.fetch.mockResolvedValueOnce(jsonResponse({ items: Array.from({ length: 101 }, (_, index) => ({ gameId: `id-${index}` })) }));
    await act(async () => { expect(await job.result.current.matching()).toBe(false); }); expect([...job.result.current.rows.keys()]).toEqual(["kept"]);
    job.fetch.mockResolvedValueOnce(jsonResponse({ message: "PRIVATE_SIGNED_URL" }, 503));
    await act(async () => { expect(await job.result.current.matching()).toBe(false); }); expect([...job.result.current.rows.keys()]).toEqual(["kept"]);
    const rows = Array.from({ length: 100 }, (_, index) => ({ gameId: `id-${index}`, result: index ? "Loss" : "Victory" })); job.fetch.mockResolvedValueOnce(jsonResponse({ items: rows }));
    await act(async () => { expect(await job.result.current.matching()).toBe(true); }); expect([...job.result.current.rows.keys()]).toEqual(rows.map(row => row.gameId));
    expect(job.result.current.rows.get("id-0")?.result).toBe("Win"); expect(job.result.current.rows.has("kept")).toBe(false);
    act(() => job.result.current.toggle({ gameId: "too-many" })); expect(job.result.current.rows.size).toBe(100);
    act(() => job.result.current.toggle({ gameId: "id-0" })); expect(job.result.current.rows.size).toBe(99);
    job.fetch.mockResolvedValueOnce(jsonResponse({ items: [] })); await act(async () => { expect(await job.result.current.matching()).toBe(true); }); expect(job.result.current.rows.size).toBe(0);
    expect(job.result.current.message).not.toContain("PRIVATE_"); expect(job.fetch).toHaveBeenCalledTimes(4);
  });

  it("cancel preserves prior rows and holds pending through real read and cancel cleanup", async () => {
    const job = setup(), body = heldResponse(); job.fetch.mockResolvedValueOnce(body.response); act(() => job.result.current.toggle({ gameId: "kept" }));
    let work!: Promise<boolean>; act(() => { work = job.result.current.matching(); });
    try {
      await waitFor(() => expect(body.reader.read).toHaveBeenCalledOnce()); act(() => job.result.current.cancelMatching());
      await waitFor(() => expect(body.reader.cancel).toHaveBeenCalledOnce()); expect(job.result.current.pending).toBe(true); expect([...job.result.current.rows.keys()]).toEqual(["kept"]);
      await act(async () => { body.cancelled.resolve(); await ticks(); }); expect(job.result.current.pending).toBe(true);
      await act(async () => { body.read.resolve({ done: true, value: undefined }); expect(await work).toBe(false); }); expect(job.result.current.pending).toBe(false);
      expect([...job.result.current.rows.keys()]).toEqual(["kept"]);
    } finally { job.result.current.cancelMatching(); body.read.resolve({ done: true, value: undefined }); body.cancelled.resolve(); await work; }
  });

  it.each(["owner", "query"] as const)("%s A→B→A clears immediately and cannot adopt held JWT or restore old rows", async field => {
    const job = setup(), jwt = deferred<string | null>(); auth.token.mockImplementationOnce(() => jwt.promise); act(() => job.result.current.toggle({ gameId: "old" }));
    let work!: Promise<boolean>; act(() => { work = job.result.current.matching(); });
    try {
      await waitFor(() => expect(auth.token).toHaveBeenCalledOnce()); job.rerender({ ...initial, [field]: field === "owner" ? "owner-b" : "sort=date_desc&search=Other" });
      expect(job.result.current.rows.size).toBe(0); job.rerender(initial); expect(job.result.current.rows.size).toBe(0); expect(job.result.current.pending).toBe(true);
      await act(async () => { jwt.resolve("retired"); expect(await work).toBe(false); }); expect(job.fetch).not.toHaveBeenCalled(); expect(job.result.current.rows.size).toBe(0);
      expect(job.result.current.message).toBeNull();
    } finally { job.result.current.cancelMatching(); jwt.resolve(null); await work; }
  });

  it("a clear during held matching invalidates its revision without restoring the earlier map, and pending filters block edits", async () => {
    const job = setup(), body = heldResponse(); job.fetch.mockResolvedValueOnce(body.response); act(() => job.result.current.toggle({ gameId: "old" }));
    let work!: Promise<boolean>; act(() => { work = job.result.current.matching(); });
    try {
      await waitFor(() => expect(body.reader.read).toHaveBeenCalledOnce()); act(() => job.result.current.clear()); expect(job.result.current.rows.size).toBe(0);
      job.rerender({ ...initial, blocked: true }); act(() => job.result.current.toggle({ gameId: "blocked" })); expect(job.result.current.rows.size).toBe(0);
      await act(async () => { expect(await job.result.current.matching()).toBe(false); body.read.resolve({ done: true, value: undefined }); body.cancelled.resolve(); expect(await work).toBe(false); });
      job.rerender(initial); expect(job.result.current.rows.size).toBe(0); expect(job.fetch).toHaveBeenCalledOnce();
    } finally { job.result.current.cancelMatching(); body.read.resolve({ done: true, value: undefined }); body.cancelled.resolve(); await work; }
  });
});
