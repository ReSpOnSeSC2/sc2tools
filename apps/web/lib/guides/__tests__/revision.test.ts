import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchGuideRevision } from "../revision";
import { GUIDE_CACHE_TAG, GUIDE_REVALIDATE_SEC } from "../api";

const fetchMock = vi.fn();
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => vi.unstubAllGlobals());

describe("guide revision server seed", () => {
  it("uses the guide purge tag without making the layout dynamic", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ revision: "revision-one" }) });
    expect(await fetchGuideRevision()).toBe("revision-one");
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/v1\/guides\/revision$/);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      next: { revalidate: GUIDE_REVALIDATE_SEC, tags: [GUIDE_CACHE_TAG] }, redirect: "error",
    });
    expect(fetchMock.mock.calls[0][1].cache).toBeUndefined();
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it.each([null, {}, { revision: "" }, { revision: 12 }, { revision: "x".repeat(129) }])("ignores malformed response %j", async (body) => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => body });
    expect(await fetchGuideRevision()).toBeNull();
  });

  it("allows older API deployments and failures without failing a guide", async () => {
    fetchMock.mockResolvedValue({ ok: false });
    expect(await fetchGuideRevision()).toBeNull();
    fetchMock.mockRejectedValue(new TypeError("network unavailable"));
    expect(await fetchGuideRevision()).toBeNull();
  });
});
