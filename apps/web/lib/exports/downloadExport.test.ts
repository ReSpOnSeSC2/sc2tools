import { afterEach, describe, expect, it, vi } from "vitest";
import { ReadableStream } from "node:stream/web";
import { Blob as NodeBlob } from "node:buffer";
import { TextEncoder } from "node:util";
import { downloadExport, type DownloadEnvironment } from "./downloadExport";
import { exportBusy, withExportAdmission } from "./exportAdmission";

const encode = new TextEncoder();
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function response(text = "row\n", headers: Record<string, string> = {}, ok = true): Response {
  return { ok, headers: new Headers({ "content-type": "text/csv", ...headers }),
    body: new ReadableStream<Uint8Array>({ start(source) { source.enqueue(encode.encode(text)); source.close(); } }) } as unknown as Response;
}
const request = { url: "https://api.example.test/v1/export/build-orders.csv", filename: "safe.csv", contentType: "text/csv" as const };
const writer = () => ({ write: vi.fn(async (_chunk: Uint8Array) => {}), close: vi.fn(async () => {}), abort: vi.fn(async () => {}) });
const scope = () => ({ token: vi.fn(async () => "synthetic-token"), signal: new AbortController().signal, assertCurrent: () => {} });
const environment = (reply = response()): DownloadEnvironment => ({ fetch: vi.fn(async () => reply) as unknown as typeof fetch, saveBlob: vi.fn() });
afterEach(() => vi.unstubAllGlobals());

describe("admitted browser export", () => {
  it("opens the save picker synchronously before JWT work and streams exact bytes before close", async () => {
    const picked = deferred<{ createWritable: () => Promise<ReturnType<typeof writer>> }>();
    const output = writer(), auth = scope(), env = { ...environment(), picker: vi.fn(() => picked.promise) };
    const work = downloadExport(request, auth, env);
    expect(env.picker).toHaveBeenCalledWith({ suggestedName: "safe.csv" });
    expect(auth.token).not.toHaveBeenCalled(); expect(env.fetch).not.toHaveBeenCalled();
    picked.resolve({ createWritable: async () => output });
    expect(await work).toEqual({ bytes: 4, continuation: null });
    expect(output.write).toHaveBeenCalledWith(encode.encode("row\n"));
    expect(output.close).toHaveBeenCalledOnce(); expect(output.abort).not.toHaveBeenCalled();
    expect(env.fetch).toHaveBeenCalledWith(request.url, expect.objectContaining({ cache: "no-store", credentials: "omit", redirect: "error", headers: { authorization: "Bearer synthetic-token" } }));
    expect(env.saveBlob).not.toHaveBeenCalled();
  });

  it.each([null, 17.5])("negotiates exact build supply and accepts legacy or updated API rows: %s", async supply => {
    vi.stubGlobal("Blob", NodeBlob);
    const text = [
      { type: "metadata", format: "sc2tools-build-order-export", version: 1, games: 1, fields: ["gameId", "side", "time", "supply", "name"] },
      { gameId: "one", side: "me", time: 1, supply, name: "Worker" },
      { type: "complete", games: 1, events: 1, continuation: null },
    ].map(row => JSON.stringify(row) + "\n").join("");
    const env = environment(response(text, { "content-type": "application/x-ndjson", "x-export-has-more": "false" }));
    const buildPage = { url: request.url.replace(".csv", ".ndjson"), filename: "safe.ndjson", contentType: "application/x-ndjson" as const,
      paged: true, ndjson: { format: "sc2tools-build-order-export" as const } };
    expect(await downloadExport(buildPage, scope(), env)).toEqual({ bytes: encode.encode(text).byteLength, continuation: null });
    expect(env.fetch).toHaveBeenCalledWith(buildPage.url, expect.objectContaining({
      headers: { authorization: "Bearer synthetic-token", accept: "application/x-ndjson; profile=exact-supply" },
    }));
    expect(await vi.mocked(env.saveBlob).mock.calls[0][0].text()).toBe(text);
  });

  it("keeps admission through a held createWritable and actual abort cleanup after cancellation", async () => {
    const entered = deferred(), opened = deferred<ReturnType<typeof writer>>(), cleaned = deferred();
    const output = writer(), abort = new AbortController(), auth = { ...scope(), signal: abort.signal };
    output.abort.mockImplementation(() => cleaned.promise);
    const env = { ...environment(), picker: async () => ({ createWritable: async () => { entered.resolve(); return opened.promise; } }) };
    const work = withExportAdmission(() => downloadExport(request, auth, env));
    void work.catch(() => {});
    try {
      await entered.promise; abort.abort();
      expect(exportBusy()).toBe(true);
      await expect(withExportAdmission(async () => {})).rejects.toMatchObject({ code: "busy" });
      opened.resolve(output); await vi.waitFor(() => expect(output.abort).toHaveBeenCalledOnce());
      expect(exportBusy()).toBe(true); expect(env.fetch).not.toHaveBeenCalled(); expect(output.write).not.toHaveBeenCalled();
      cleaned.resolve(); await expect(work).rejects.toMatchObject({ code: "cancelled" });
      expect(exportBusy()).toBe(false);
    } finally { opened.resolve(output); cleaned.resolve(); await work.catch(() => {}); }
  });

  it("does not open a writer or fetch when an old owner returns from the picker", async () => {
    const picked = deferred<{ createWritable: ReturnType<typeof vi.fn> }>(), createWritable = vi.fn();
    let current = true;
    const env = { ...environment(), picker: () => picked.promise };
    const work = downloadExport(request, { ...scope(), assertCurrent: () => { if (!current) throw new DOMException("Retired", "AbortError"); } }, env);
    current = false; picked.resolve({ createWritable });
    await expect(work).rejects.toMatchObject({ code: "cancelled" });
    expect(createWritable).not.toHaveBeenCalled(); expect(env.fetch).not.toHaveBeenCalled();
  });

  it("creates a fallback artifact only after validated complete NDJSON and binds the internal API UUID", async () => {
    vi.stubGlobal("Blob", NodeBlob);
    const text = '{"type":"metadata","format":"sc2tools-account-export","version":1,"userId":"internal-a"}\n{"type":"user","row":{}}\n{"type":"complete","counts":{}}\n';
    const env = environment(response(text, { "content-type": "application/x-ndjson" }));
    const account = { ...request, contentType: "application/x-ndjson" as const, ndjson: { format: "sc2tools-account-export" as const, apiOwner: "internal-a" } };
    await downloadExport(account, scope(), env);
    expect(env.saveBlob).toHaveBeenCalledOnce();
    const saved = vi.mocked(env.saveBlob).mock.calls[0][0]; expect(await saved.text()).toBe(text);
    const wrong = environment(response(text, { "content-type": "application/x-ndjson" }));
    await expect(downloadExport({ ...account, ndjson: { ...account.ndjson, apiOwner: "clerk-a" } }, scope(), wrong)).rejects.toMatchObject({ code: "invalid" });
    expect(wrong.saveBlob).not.toHaveBeenCalled();
  });

  it.each<Record<string, string>>([
    { "x-export-has-more": "true" },
    { "x-export-has-more": "false", "x-export-continuation-token": "unexpected" },
    { "x-export-has-more": "maybe" },
  ])("rejects inconsistent paging headers before committing a file: %j", async headers => {
    const output = writer(), env = { ...environment(response("row\n", headers)), picker: async () => ({ createWritable: async () => output }) };
    await expect(downloadExport({ ...request, paged: true }, scope(), env)).rejects.toMatchObject({ code: "invalid" });
    expect(output.write).not.toHaveBeenCalled(); expect(output.close).not.toHaveBeenCalled(); expect(output.abort).toHaveBeenCalledOnce();
  });

  it("returns an opaque continuation only after the page is complete", async () => {
    vi.stubGlobal("Blob", NodeBlob);
    const env = environment(response("row\n", { "x-export-has-more": "true", "x-export-continuation-token": "opaque.next" }));
    expect(await downloadExport({ ...request, paged: true }, scope(), env)).toEqual({ bytes: 4, continuation: "opaque.next" });
    expect(env.saveBlob).toHaveBeenCalledOnce();
  });

  it("redacts authentication and server failures, aborts the selected file, and never retries", async () => {
    const output = writer(), env = { ...environment(), picker: async () => ({ createWritable: async () => output }) };
    await expect(downloadExport(request, { ...scope(), token: async () => { throw new Error("Bearer private-token /private/path"); } }, env)).rejects.toMatchObject({ code: "failed", message: "Couldn't complete the export. Please try again." });
    expect(env.fetch).not.toHaveBeenCalled(); expect(output.abort).toHaveBeenCalledOnce();
    const failed = { ...environment(response("Bearer private-server-body", {}, false)), picker: async () => ({ createWritable: async () => output }) };
    await expect(downloadExport(request, scope(), failed)).rejects.toMatchObject({ code: "failed", message: "Couldn't complete the export. Please try again." });
    expect(failed.fetch).toHaveBeenCalledOnce(); expect(output.close).not.toHaveBeenCalled();
  });
});
