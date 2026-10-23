import { describe, expect, it, vi } from "vitest";
import { createPresetPolicyRefresh } from "../presetPolicyRefresh";
import type { EngineRuntime } from "../enginePyGlue";

function fixture(initial: string | null = null) {
  let stored = initial;
  let active = "bundled";
  const installPolicy = vi.fn((raw: string) => {
    if (!raw.startsWith("valid:")) throw new Error("incompatible_or_hash_mismatch");
    active = raw; return raw;
  });
  const runtime = { installPolicy } as unknown as EngineRuntime;
  const cache = {
    match: vi.fn(async () => stored === null ? undefined : new Response(stored)),
    put: vi.fn(async (_url: string, response: Response) => { stored = await response.text(); }),
  };
  const caches = { open: vi.fn(async () => cache as unknown as Cache) };
  return { runtime, caches, cache, active: () => active, stored: () => stored };
}

describe("public preset policy refresh", () => {
  it("restores a compatible durable value offline and never sends credentials/replay data", async () => {
    const f = fixture("valid:last-good");
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("offline"));
    const refresh = createPresetPolicyRefresh("https://api.example.test/", { fetch, caches: f.caches });
    await refresh(f.runtime);
    expect(f.active()).toBe("valid:last-good");
    expect(fetch).toHaveBeenCalledWith("https://api.example.test/v1/build-policy?evaluator=1", { credentials: "omit", signal: expect.any(AbortSignal), cache: "no-cache" });
    expect(f.cache.put).not.toHaveBeenCalled();
  });

  it("coalesces refreshes, bounds cadence, installs before persistence and retries after the minute", async () => {
    const f = fixture(); let now = 100;
    let resolve!: (response: Response) => void;
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementationOnce(() => new Promise((done) => { resolve = done; })).mockResolvedValue(new Response("valid:two"));
    const refresh = createPresetPolicyRefresh("https://api.example.test", { fetch, caches: f.caches, now: () => now });
    const one = refresh(f.runtime); const two = refresh(f.runtime);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    resolve(new Response("valid:one")); await Promise.all([one, two]);
    expect(f.stored()).toBe("valid:one"); expect(f.active()).toBe("valid:one");
    await refresh(f.runtime); expect(fetch).toHaveBeenCalledTimes(1);
    now += 60001; await refresh(f.runtime); expect(f.active()).toBe("valid:two");
    expect(f.cache.put).toHaveBeenCalledTimes(2);
  });

  it.each(["unsupported", "x".repeat(1024 * 1024 + 1)])("rejects invalid or oversized downloads without replacing durable/installed state (%#)", async (raw) => {
    const f = fixture("valid:last-good");
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(raw));
    await createPresetPolicyRefresh("https://api.example.test", { fetch, caches: f.caches })(f.runtime);
    expect(f.active()).toBe("valid:last-good"); expect(f.stored()).toBe("valid:last-good");
    expect(f.cache.put).not.toHaveBeenCalled();
  });

  it("continues with released defaults when both cache and API are unavailable", async () => {
    const f = fixture("invalid");
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("upgrade", { status: 426 }));
    await createPresetPolicyRefresh("https://api.example.test", { fetch, caches: f.caches })(f.runtime);
    expect(f.active()).toBe("bundled"); expect(f.cache.put).not.toHaveBeenCalled();
  });
});
