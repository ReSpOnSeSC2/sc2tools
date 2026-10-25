// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { PUBLIC_OG_READ_TIMEOUT_MS, readPublicOg } from "./readPublicOg";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe("bounded public social image reads", () => {
  it.each(["headers", "body"])("returns neutral data when %s are held", async phase => {
    vi.useFakeTimers();
    const held = new Promise<never>(() => {});
    const fetcher = vi.fn().mockImplementation(() => phase === "headers" ? held : Promise.resolve({ ok: true, status: 200, json: () => held }));
    vi.stubGlobal("fetch", fetcher);
    const result = readPublicOg("/v1/community/builds/public-build");
    await vi.advanceTimersByTimeAsync(PUBLIC_OG_READ_TIMEOUT_MS);
    expect(await result).toBeNull();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reads one successful public payload and clears its deadline", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ title: "Opening" }) }));
    expect(await readPublicOg("/v1/community/builds/public-build")).toEqual({ title: "Opening" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([404, 503])("uses neutral data for HTTP %s", async status => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status }));
    expect(await readPublicOg("/v1/community/authors/public-author")).toBeNull();
  });

  it("handles malformed JSON without leaking a raw response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => { throw Error("private upstream detail"); } }));
    expect(await readPublicOg("/v1/community/builds/public-build")).toBeNull();
  });
  it("shares configured public Community tags without transporting the secret", async () => {
    vi.stubEnv("COMMUNITY_REVALIDATE_SECRET", "local-secret");
    const fetcher = vi.fn().mockResolvedValue(Response.json({ title: "Public" })); vi.stubGlobal("fetch", fetcher);
    await readPublicOg("/v1/community/builds/public-build");
    expect(fetcher.mock.calls[0][1].next).toEqual({ revalidate: 300, tags: ["community", "community-build:public-build"] });
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain("local-secret");
  });
});
