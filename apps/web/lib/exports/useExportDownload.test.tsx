import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { SWRConfig, unstable_serialize } from "swr";
import type { ReactNode } from "react";
import { ReadableStream } from "node:stream/web";
import { Blob as NodeBlob } from "node:buffer";
import { TextEncoder } from "node:util";
import { useExportDownload } from "./useExportDownload";
import { exportBusy } from "./exportAdmission";

const auth = vi.hoisted(() => ({ owner: "clerk-a" as string | null, token: vi.fn(async (): Promise<string | null> => "synthetic") }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ userId: auth.owner, isLoaded: true, isSignedIn: !!auth.owner, getToken: auth.token }) }));
const encode = new TextEncoder();
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function reply(): Response {
  return { ok: true, headers: new Headers({ "content-type": "text/csv" }),
    body: new ReadableStream<Uint8Array>({ start(source) { source.enqueue(encode.encode("row\n")); source.close(); } }) } as unknown as Response;
}
const request = { url: "https://api.example.test/export", filename: "safe.csv", contentType: "text/csv" as const };
function setup() {
  const cache = new Map();
  cache.set(unstable_serialize(["authenticated-api", "clerk-a", "/v1/me"]), { data: { userId: "internal-a" } });
  cache.set(unstable_serialize(["authenticated-api", "clerk-b", "/v1/me"]), { data: { userId: "internal-b" } });
  const wrapper = ({ children }: { children: ReactNode }) => <SWRConfig value={{ provider: () => cache, keepPreviousData: true }}>{children}</SWRConfig>;
  return renderHook(() => useExportDownload(), { wrapper });
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); auth.owner = "clerk-a"; auth.token.mockReset().mockResolvedValue("synthetic"); expect(exportBusy()).toBe(false); });

describe("Settings export owner lifetime", () => {
  it("subscribes to the existing owner-keyed API UUID without another profile request or previous-owner fallback", () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const { result, rerender } = setup();
    expect(result.current.apiOwner).toBe("internal-a");
    auth.owner = "clerk-b"; rerender(); expect(result.current.apiOwner).toBe("internal-b");
    auth.owner = "clerk-c"; rerender(); expect(result.current.apiOwner).toBeNull();
    auth.owner = null; rerender(); expect(result.current.apiOwner).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects A→B→A completion while keeping admission until the actual old JWT settles", async () => {
    const jwt = deferred<string | null>(); auth.token.mockImplementationOnce(() => jwt.promise);
    const fetch = vi.fn(async () => reply()); vi.stubGlobal("fetch", fetch); vi.stubGlobal("Blob", NodeBlob);
    const output = { write: vi.fn(async () => {}), close: vi.fn(async () => {}), abort: vi.fn(async () => {}) };
    vi.stubGlobal("showSaveFilePicker", vi.fn(async () => ({ createWritable: async () => output })));
    const { result, rerender } = setup(); let old!: Promise<boolean>;
    act(() => { old = result.current.run(request); });
    try {
      await waitFor(() => expect(auth.token).toHaveBeenCalledOnce());
      auth.owner = "clerk-b"; rerender();
      expect(result.current.feedback).toBeNull(); expect(result.current.apiOwner).toBe("internal-b");
      auth.owner = "clerk-a"; rerender();
      await act(async () => { expect(await old).toBe(false); });
      expect(result.current.busy).toBe(true); expect(fetch).not.toHaveBeenCalled();
      await act(async () => { expect(await result.current.run(request)).toBe(false); });
      expect(auth.token).toHaveBeenCalledOnce();
      await act(async () => { jwt.resolve("old-token"); });
      await waitFor(() => expect(result.current.busy).toBe(false));
      expect(fetch).not.toHaveBeenCalled(); expect(output.close).not.toHaveBeenCalled(); expect(output.abort).toHaveBeenCalledOnce();
      expect(result.current.feedback).toBeNull();
      await act(async () => { expect(await result.current.run(request)).toBe(true); });
      expect(fetch).toHaveBeenCalledOnce(); expect(result.current.feedback?.message).toContain("Export saved");
    } finally { jwt.resolve("old-token"); await old; await waitFor(() => expect(exportBusy()).toBe(false)); }
  });

  it("a repeated click cannot replace the active cancel controller or release held file cleanup", async () => {
    const entered = deferred(), written = deferred(), cleaned = deferred();
    const output = { write: vi.fn(async () => { entered.resolve(); await written.promise; }), close: vi.fn(async () => {}), abort: vi.fn(() => cleaned.promise) };
    vi.stubGlobal("fetch", vi.fn(async () => reply()));
    const picker = vi.fn(async () => ({ createWritable: async () => output })); vi.stubGlobal("showSaveFilePicker", picker);
    const { result } = setup(); let work!: Promise<boolean>;
    act(() => { work = result.current.run(request); });
    try {
      await entered.promise;
      await act(async () => { expect(await result.current.run(request)).toBe(false); result.current.cancel(); });
      await waitFor(() => expect(output.abort).toHaveBeenCalledOnce());
      expect(picker).toHaveBeenCalledOnce(); expect(exportBusy()).toBe(true);
      await act(async () => { written.resolve(); });
      expect(exportBusy()).toBe(true); expect(output.close).not.toHaveBeenCalled();
      await act(async () => { cleaned.resolve(); expect(await work).toBe(false); });
      await waitFor(() => expect(result.current.busy).toBe(false));
      expect(result.current.feedback?.message).toBe("Export cancelled.");
    } finally { written.resolve(); cleaned.resolve(); await work; await waitFor(() => expect(exportBusy()).toBe(false)); }
  });
});
