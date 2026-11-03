// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadReplayPack, type ReplayPackEnvironment } from "./downloadReplayPack";
import { exportBusy } from "../exportAdmission";
import { PackTestWorker, bytesResponse, deferred, envelope, heldResponse, jsonResponse, outputSink, readyRow, testJob, testNow, ticks } from "./replayPackTestFixtures";

const request = (ids = ["one"]) => ({ apiUrl: "https://api.example.test/v1/replays/download-batch", rows: ids.map(gameId => ({ gameId })), template: "game-id" as const });
const scope = (controller = new AbortController()) => ({ signal: controller.signal, assertCurrent: () => {}, token: vi.fn(async (): Promise<string | null> => "synthetic-token") });
function setup(fetcher?: typeof fetch) {
  const worker = new PackTestWorker(), output = outputSink(), saveBlob = vi.fn();
  const fetch = fetcher || vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => init?.method === "POST"
    ? jsonResponse(envelope((JSON.parse(String(init.body)).gameIds as string[]).map(id => readyRow(id)))) : bytesResponse());
  const environment: ReplayPackEnvironment = { fetch, picker: vi.fn(async () => ({ createWritable: async () => output })), saveBlob, workerFactory: worker.factory, job: () => testJob, now: () => testNow };
  return { worker, output, saveBlob, fetch, environment };
}
afterEach(() => { expect(exportBusy()).toBe(false); });

describe("bounded replay pack controller", () => {
  it("captures the recorded result before a held picker and keeps it separate from download status in the manifest", async () => {
    const fixture = setup(), picked = deferred<{ createWritable: () => Promise<ReturnType<typeof outputSink>> }>();
    fixture.environment.picker = vi.fn(() => picked.promise);
    const row = { gameId: "one", date: "2026-11-03", matchup: "PvT", opponent: "Other", map: "Map", result: "Victory" };
    const work = downloadReplayPack({ ...request(), rows: [row], template: "descriptive" }, scope(), fixture.environment);
    const observed = work.then(value => value, error => error);
    try {
      row.result = "Defeat"; picked.resolve({ createWritable: async () => fixture.output }); const result = await observed;
      expect(result).toMatchObject({ saved: 1, items: [{ filename: "2026-11-03 PvT Win vs Other on Map.SC2Replay", status: "saved" }] });
      const manifest = fixture.worker.input.find(entry => entry.type === "entry" && entry.kind === "manifest");
      expect(manifest?.type === "entry" ? new TextDecoder().decode(manifest.bytes) : "").toContain('"Win","saved"');
    } finally { picked.resolve({ createWritable: async () => fixture.output }); await observed; }
  });

  it("calls the picker synchronously before JWT, signs four slots, joins the batch and ordered ACKs before the fifth", async () => {
    const first = heldResponse(), outputEntered = deferred(), outputWritten = deferred(), signed: string[][] = [], options: RequestInit[] = [];
    const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") { const ids = JSON.parse(String(init.body)).gameIds as string[]; signed.push(ids); return jsonResponse(envelope(ids.map(id => readyRow(id)))); }
      options.push(init!); return String(url).includes("/one?") ? first.response : bytesResponse();
    });
    const fixture = setup(fetch), current = scope();
    fixture.output.write.mockImplementationOnce(async () => { outputEntered.resolve(); await outputWritten.promise; });
    const work = downloadReplayPack(request(["one", "two", "three", "four", "five"]), current, fixture.environment);
    const observed = work.then(value => value, error => error);
    expect(fixture.environment.picker).toHaveBeenCalledOnce(); expect(current.token).not.toHaveBeenCalled(); expect(exportBusy()).toBe(true);
    try {
      await first.entered.promise; await ticks(); expect(options).toHaveLength(4); expect(signed).toEqual([["one", "two", "three", "four"]]);
      expect(fixture.output.write).not.toHaveBeenCalled();
      first.read.resolve({ done: false, value: new Uint8Array([1, 2, 3, 4]) }); await outputEntered.promise;
      expect(signed).toHaveLength(1); expect(options).toHaveLength(4); expect(fixture.worker.input.filter(row => row.type === "ack")).toHaveLength(0);
      outputWritten.resolve(); const result = await observed;
      expect(result).toMatchObject({ requested: 5, saved: 5, failed: 0 }); expect(signed).toEqual([["one", "two", "three", "four"], ["five"]]);
      const entries = fixture.worker.input.filter(row => row.type === "entry");
      expect(entries.map(row => row.name)).toEqual(["one.SC2Replay", "two.SC2Replay", "three.SC2Replay", "four.SC2Replay", "five.SC2Replay", "manifest.csv", "README.txt"]);
      for (const init of options) { expect(init).toMatchObject({ credentials: "omit", referrerPolicy: "no-referrer", redirect: "error", cache: "no-store" }); expect(init.headers).toBeUndefined(); }
      expect(fetch.mock.calls[0][1]).toMatchObject({ method: "POST", headers: { authorization: "Bearer synthetic-token", "content-type": "application/json" } });
      expect(fixture.output.close).toHaveBeenCalledOnce(); expect(fixture.output.abort).not.toHaveBeenCalled(); expect(fixture.worker.listenerCount()).toBe(0);
    } finally { first.read.resolve({ done: true, value: undefined }); first.cancelled.resolve(); outputWritten.resolve(); await observed; }
  });

  it("preserves requested partial results and never sends signed URLs, token fields or server names to ZIP metadata", async () => {
    const fixture = setup(vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") return jsonResponse(envelope([readyRow("one"), readyRow("two"), { gameId: "three", status: "unavailable", code: "replay_unavailable" }]));
      return String(url).includes("/two?") ? bytesResponse(new Uint8Array(3), 200, { "content-length": "4" }) : bytesResponse();
    }));
    const result = await downloadReplayPack({ ...request(["one", "two", "three"]), rows: [{ gameId: "one", map: "https://private.example/PRIVATE_SIGNED_SENTINEL", opponent: "Bearer PRIVATE_TOKEN" }, { gameId: "two" }, { gameId: "three" }] }, scope(), fixture.environment);
    expect(result).toMatchObject({ saved: 1, failed: 2, items: [{ status: "saved" }, { status: "failed", filename: "" }, { status: "unavailable", filename: "" }] });
    const entries = fixture.worker.input.filter(row => row.type === "entry"); expect(entries.map(row => row.name)).toEqual(["one.SC2Replay", "manifest.csv", "README.txt"]);
    const metadata = entries.filter(row => row.kind !== "replay").map(row => new TextDecoder().decode(row.bytes)).join("\n");
    expect(metadata).toContain("one.SC2Replay"); expect(metadata.indexOf("one")).toBeLessThan(metadata.indexOf("two")); expect(metadata).toContain("unavailable");
    expect(metadata).not.toMatch(/PRIVATE_|signature|ignored\.SC2Replay|https:/u); expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|signature|https:/u);
  });

  it.each([206, 403])("started HTTP%s and short HTTP200 are fixed file failures with no retry", async status => {
    const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => init?.method === "POST"
      ? jsonResponse(envelope([readyRow("one"), readyRow("two")])) : String(url).includes("/one?") ? bytesResponse(undefined, status) : bytesResponse(new Uint8Array(3)));
    const fixture = setup(fetch); const result = await downloadReplayPack(request(["one", "two"]), scope(), fixture.environment);
    expect(result).toMatchObject({ saved: 0, failed: 2 }); expect(fetch).toHaveBeenCalledTimes(3);
    expect(fixture.worker.input.filter(row => row.type === "entry" && row.kind === "replay")).toHaveLength(0);
  });

  it("refreshes only unstarted expiry once, reserving flags before signing, and never retries renewed expiry", async () => {
    let signs = 0; const groups: string[][] = [];
    const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== "POST") return bytesResponse();
      const ids = JSON.parse(String(init.body)).gameIds as string[]; groups.push(ids); signs++;
      return jsonResponse(envelope(signs === 1 ? [readyRow("one", { issuedAt: "2026-11-03T05:59:00.000Z", expiresAt: "2026-11-03T06:00:00.000Z" }),
        { gameId: "two", status: "retryable", code: "replay_download_expired" }, readyRow("three")]
        : [readyRow("one"), { gameId: "two", status: "retryable", code: "replay_download_expired" }]));
    });
    const fixture = setup(fetch), result = await downloadReplayPack(request(["one", "two", "three"]), scope(), fixture.environment);
    expect(groups).toEqual([["one", "two", "three"], ["one", "two"]]); expect(fetch).toHaveBeenCalledTimes(4);
    expect(result.items.map(row => row.status)).toEqual(["saved", "failed", "saved"]);
  });

  it.each([429, 503])("does not retry busy/unknown API HTTP%s and creates no output artifact", async status => {
    const fetch = vi.fn(async () => jsonResponse({ message: "PRIVATE_TOKEN" }, status)), fixture = setup(fetch);
    await expect(downloadReplayPack(request(), scope(), fixture.environment)).rejects.toMatchObject({ code: "failed", message: "Couldn't complete the export. Please try again." });
    expect(fetch).toHaveBeenCalledOnce(); expect(fixture.output.abort).toHaveBeenCalledOnce(); expect(fixture.output.close).not.toHaveBeenCalled(); expect(fixture.saveBlob).not.toHaveBeenCalled();
  });

  it("rejects the whole malformed signing envelope without fetching or writing any replay", async () => {
    const value = envelope([readyRow("one")]); value.counts.available = 0;
    const fetch = vi.fn(async () => jsonResponse(value)), fixture = setup(fetch);
    await expect(downloadReplayPack(request(), scope(), fixture.environment)).rejects.toMatchObject({ code: "invalid" });
    expect(fetch).toHaveBeenCalledOnce(); expect(fixture.worker.input.some(row => row.type === "entry")).toBe(false);
    expect(fixture.output.abort).toHaveBeenCalledOnce(); expect(fixture.output.close).not.toHaveBeenCalled(); expect(fixture.saveBlob).not.toHaveBeenCalled();
  });

  it("keeps global admission through actual held JWT and sink cleanup after cancel", async () => {
    const fixture = setup(), jwt = deferred<string | null>(), aborted = deferred(), controller = new AbortController(), current = scope(controller);
    current.token.mockImplementation(() => jwt.promise); fixture.output.abort.mockImplementation(() => aborted.promise);
    const work = downloadReplayPack(request(), current, fixture.environment), observed = work.then(() => null, error => error);
    try {
      await vi.waitFor(() => expect(current.token).toHaveBeenCalledOnce()); controller.abort(); await ticks(); expect(exportBusy()).toBe(true);
      await expect(downloadReplayPack(request(), scope(), fixture.environment)).rejects.toMatchObject({ code: "busy" }); expect(fixture.fetch).not.toHaveBeenCalled();
      jwt.resolve("retired-secret"); await vi.waitFor(() => expect(fixture.output.abort).toHaveBeenCalledOnce()); expect(exportBusy()).toBe(true);
      aborted.resolve(); expect(await observed).toMatchObject({ code: "cancelled" }); expect(fixture.fetch).not.toHaveBeenCalled();
    } finally { jwt.resolve(null); aborted.resolve(); await observed; }
  });

  it("rejects invalid raw selections before picker/JWT/network and snapshots metadata while picker is held", async () => {
    const fixture = setup(), current = scope();
    for (const ids of [[], Array.from({ length: 101 }, (_, index) => `id-${index}`), ["one", " one "], ["https://private.example"], ["bad\ud800"]]) {
      await expect(downloadReplayPack(request(ids), current, fixture.environment)).rejects.toMatchObject({ code: "invalid" });
    }
    expect(fixture.environment.picker).not.toHaveBeenCalled(); expect(current.token).not.toHaveBeenCalled(); expect(fixture.fetch).not.toHaveBeenCalled();
    const picked = deferred<{ createWritable: () => Promise<ReturnType<typeof outputSink>> }>(); fixture.environment.picker = vi.fn(() => picked.promise);
    const selected = request(); const work = downloadReplayPack(selected, current, fixture.environment);
    selected.rows[0].gameId = "changed"; selected.apiUrl = "https://wrong.example";
    picked.resolve({ createWritable: async () => fixture.output }); await work;
    expect(fixture.fetch).toHaveBeenCalledWith("https://api.example.test/v1/replays/download-batch", expect.objectContaining({ body: JSON.stringify({ gameIds: ["one"] }) }));
    expect(fixture.worker.input.some(row => row.type === "entry" && row.name === "one.SC2Replay")).toBe(true);
  });
});
