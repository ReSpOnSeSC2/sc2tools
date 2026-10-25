import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readSynced, writeSynced } from "../ghostBuild";
const target = { v: 1 as const, name: "Opening", steps: [{ supply: null, t: 30, name: "Gateway" }] };
const fetcher = vi.fn();
beforeEach(() => { fetcher.mockReset(); vi.stubGlobal("fetch", fetcher); });
afterEach(() => vi.unstubAllGlobals());
describe("framework-free synced Ghost transport", () => {
  it("reads absent configuration and preserves validated response revisions", async () => {
    fetcher.mockResolvedValueOnce(new Response("null", { status: 200 })).mockResolvedValueOnce(new Response(JSON.stringify({ v: 2, slots: {}, revision: 7 }), { status: 200 }));
    expect(await readSynced(async () => "synthetic")).toBeNull();
    expect(await readSynced(async () => "synthetic")).toEqual({ v: 2, slots: {}, revision: 7 });
  });
  it("writes one slot privately without embedding credentials or replacing other slots", async () => {
    fetcher.mockResolvedValue(new Response(JSON.stringify({ v: 2, slots: { PvT: target }, revision: 3 }), { status: 200 }));
    expect((await writeSynced(async () => "synthetic", { matchup: "PvT", target, expectedTarget: null })).revision).toBe(3);
    const [url, init] = fetcher.mock.calls[0]; expect(url).toMatch(/\/v1\/me\/preferences\/ghost$/);
    expect(init).toMatchObject({ method: "PATCH", cache: "no-store", headers: { authorization: "Bearer synthetic" } });
    expect(JSON.parse(init.body)).toEqual({ matchup: "PvT", target, expectedTarget: null });
  });
  it("does not send a held token after its caller aborts", async () => {
    let release!: (value: string) => void; const controller = new AbortController();
    const pending = readSynced(() => new Promise(resolve => { release = resolve; }), controller.signal);
    // The exported codec transport is loaded lazily first.
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    controller.abort(); release("old-token"); await expect(pending).rejects.toMatchObject({ name: "AbortError" }); expect(fetcher).not.toHaveBeenCalled();
  });
  it("uses honest conflict copy and never forwards arbitrary error body text", async () => {
    fetcher.mockResolvedValue(new Response(JSON.stringify({ error: { code: "ghost_config_changed", message: "Private arbitrary body" } }), { status: 409 }));
    await expect(writeSynced(async () => "synthetic", { matchup: "PvT", target })).rejects.toMatchObject({ status: 409, code: "ghost_config_changed", message: "This matchup changed in another browser. Refresh the assignment and try again." });
  });
});
