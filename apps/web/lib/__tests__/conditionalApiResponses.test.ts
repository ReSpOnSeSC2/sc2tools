import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import { createConditionalApiResponses, type ConditionalRead } from "../conditionalApiResponses";
import { rejectConditionalAuth, retireConditionalScope, type ConditionalApiScope } from "../conditionalApiScope";

type Data = { values: number[]; label?: string };
let nextId = 0;
const tag = `W/"uc1-${"a".repeat(64)}"`;
const tag2 = `W/"uc1-${"b".repeat(64)}"`;
const scope = (owner = "A"): ConditionalApiScope => ({
  id: ++nextId, owner, active: true, retired: false, capabilities: 63, retention: {}, onRetire: new Set(),
});
const ok = (value: Data, validator = tag) => new Response(JSON.stringify(value), {
  headers: { etag: validator, "cache-control": "private, no-cache" },
});
const unchanged = (validator = tag) => new Response(null, { status: 304, headers: { etag: validator } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function input(ownerScope: ConditionalApiScope, fetchResponse: ConditionalRead<Data>["fetchResponse"],
  overrides: Partial<ConditionalRead<Data>> = {}): ConditionalRead<Data> {
  return { scope: ownerScope, owner: ownerScope.owner!, origin: "https://api.sc2tools.com",
    path: "/v1/timeseries?map=界#1", assertCurrent: () => {}, fetchResponse,
    ordinary: vi.fn(async () => ({ values: [99] })),
    fail: async res => { throw Object.assign(new Error("API error"), { status: res.status }); }, ...overrides };
}

describe("manual conditional retained representations", () => {
  it("retains raw immutable JSON and reconstructs a fresh DTO for each304", async () => {
    const engine = createConditionalApiResponses(), owner = scope();
    const fetcher = vi.fn().mockResolvedValueOnce(ok({ values: [1] })).mockImplementation(async () => unchanged());
    const call = input(owner, fetcher);
    const first = await engine.read(call); first.values.push(2);
    const second = await engine.read(call); expect(second).toEqual({ values: [1] });
    second.values[0] = 7;
    expect(await engine.read(call)).toEqual({ values: [1] });
    expect(fetcher.mock.calls.map(([value]) => value)).toEqual([undefined, tag, tag]);
    expect(engine.snapshot()).toMatchObject({ entries: 1, active: 0, reserved: 0, retiredPins: 0 });
  });

  it.each(["origin", "query", "revision", "owner"] as const)("separates the full %s identity", async part => {
    const engine = createConditionalApiResponses(), owner = scope(), other = scope("B");
    await engine.read(input(owner, async () => ok({ values: [1] })));
    const fetcher = vi.fn(async () => ok({ values: [2] }));
    const change = part === "origin" ? { origin: "https://other.invalid" }
      : part === "query" ? { path: "/v1/timeseries?map=Other#1" }
      : part === "revision" ? { path: "/v1/timeseries?map=界#2" } : { scope: other, owner: "B" };
    expect(await engine.read(input(owner, fetcher, change))).toEqual({ values: [2] });
    expect(fetcher).toHaveBeenCalledWith(undefined);
  });

  it("allows held old-key completion only into that old path while a sibling retains it", async () => {
    const engine = createConditionalApiResponses(), owner = scope(), held = deferred<Response>();
    const old = engine.read(input(owner, () => held.promise));
    const newPath = "/v1/timeseries?map=New#2";
    await engine.read(input(owner, async () => ok({ values: [2] }, tag2), { path: newPath }));
    held.resolve(ok({ values: [1] })); await old;
    const oldFetch = vi.fn(async () => unchanged()), newFetch = vi.fn(async () => unchanged(tag2));
    expect(await engine.read(input(owner, oldFetch))).toEqual({ values: [1] });
    expect(await engine.read(input(owner, newFetch, { path: newPath }))).toEqual({ values: [2] });
    expect(oldFetch).toHaveBeenCalledWith(tag); expect(newFetch).toHaveBeenCalledWith(tag2);
  });

  it.each(["absent", "mismatch", "expired"] as const)("recovers a %s body304 once without another conditional", async mode => {
    let now = 1; const engine = createConditionalApiResponses({ now: () => now, limits: { ttlMs: 10 } }), owner = scope();
    if (mode !== "absent") await engine.read(input(owner, async () => ok({ values: [1] })));
    if (mode === "expired") now = 12;
    const ordinary = vi.fn(async () => ({ values: [9] }));
    const fetcher = vi.fn(async () => unchanged(mode === "mismatch" ? tag2 : tag));
    expect(await engine.read(input(owner, fetcher, { ordinary }))).toEqual({ values: [9] });
    expect(fetcher).toHaveBeenCalledOnce(); expect(ordinary).toHaveBeenCalledOnce();
    expect(engine.snapshot().active).toBe(0);
  });

  it("propagates a second unconditional304 error without a retry loop", async () => {
    const engine = createConditionalApiResponses(), owner = scope();
    const error = Object.assign(new Error("raw304"), { status: 304 });
    const ordinary = vi.fn(async () => { throw error; }), fetcher = vi.fn(async () => unchanged());
    await expect(engine.read(input(owner, fetcher, { ordinary }))).rejects.toBe(error);
    expect(ordinary).toHaveBeenCalledOnce(); expect(fetcher).toHaveBeenCalledOnce();
    expect(engine.snapshot().active + engine.snapshot().reserved).toBe(0);
  });

  it("handles a baseline/no-capability200 through res.json and removes that route's retained pair", async () => {
    const engine = createConditionalApiResponses(), owner = scope();
    await engine.read(input(owner, async () => ok({ values: [1] })));
    const res = new Response(JSON.stringify({ values: [2] }), { headers: { etag: '"native-express"' } });
    expect(await engine.read(input(owner, async () => res))).toEqual({ values: [2] });
    expect(owner.capabilities & 1).toBe(0); expect(engine.snapshot().entries).toBe(0);
    const ordinary = vi.fn(async () => ({ values: [3] })), fetcher = vi.fn();
    await engine.read(input(owner, fetcher, { ordinary }));
    expect(fetcher).not.toHaveBeenCalled(); expect(ordinary).toHaveBeenCalledOnce();
  });

  it("charges exact UTF8 body/key/tag plus fixed allowance, expires absolutely and evicts only idle entries", async () => {
    let now = 1; const engine = createConditionalApiResponses({ now: () => now, limits: { entries: 1, ttlMs: 10 } });
    const owner = scope(), call = input(owner, async () => ok({ values: [1], label: "界😀" }));
    await engine.read(call);
    const key = JSON.stringify([call.origin, owner.id, "A", call.path]);
    expect(engine.snapshot().bytes).toBe(Buffer.byteLength(JSON.stringify({ values: [1], label: "界😀" }))
      + Buffer.byteLength(key) + Buffer.byteLength(tag) + 256);
    await engine.read(input(owner, async () => ok({ values: [2] }), { path: "/v1/momentum#2" }));
    expect(engine.snapshot().entries).toBe(1);
    now = 12; const fetcher = vi.fn(async () => ok({ values: [3] }));
    await engine.read(input(owner, fetcher));
    expect(fetcher).toHaveBeenCalledWith(undefined); expect(engine.snapshot().entries).toBe(1);
  });

  it("returns oversized valid JSON and oversized-key reads without adding retention or busy errors", async () => {
    const engine = createConditionalApiResponses({ limits: { bodyBytes: 40, keyBytes: 150 } }), owner = scope();
    const large = { values: [1], label: "界".repeat(60) };
    expect(await engine.read(input(owner, async () => ok(large)))).toEqual(large);
    expect(engine.snapshot().entries).toBe(0);
    const ordinary = vi.fn(async () => ({ values: [8] })), fetcher = vi.fn();
    expect(await engine.read(input(owner, fetcher, { path: `/v1/timeseries?q=${"界".repeat(200)}`, ordinary }))).toEqual({ values: [8] });
    expect(ordinary).toHaveBeenCalledOnce(); expect(fetcher).not.toHaveBeenCalled();
  });

  it("returns an oversized new200 but retires its older pair before any future validator", async () => {
    const engine = createConditionalApiResponses({ limits: { bodyBytes: 40 } }), owner = scope();
    await engine.read(input(owner, async () => ok({ values: [1] })));
    expect(engine.snapshot().entries).toBe(1);
    const large = { values: [2], label: "界".repeat(60) };
    expect(await engine.read(input(owner, async () => ok(large, tag2)))).toEqual(large);
    expect(engine.snapshot().entries).toBe(0); expect(engine.snapshot().bytes).toBe(0);
    const next = vi.fn(async () => ok({ values: [3] }));
    await engine.read(input(owner, next));
    expect(next).toHaveBeenCalledWith(undefined);
  });

  it("401 retires capabilities and prevents a held old-generation200 body refilling even after rediscovery", async () => {
    const engine = createConditionalApiResponses(), owner = scope(), body = deferred<string>(), began = deferred<void>();
    await engine.read(input(owner, async () => ok({ values: [1] })));
    const oldGeneration = owner.retention;
    const pending = engine.read(input(owner, async () => {
      const res = ok({ values: [2] });
      Object.defineProperty(res, "text", { value: () => { began.resolve(); return body.promise; } });
      return res;
    }));
    await began.promise;
    await expect(engine.read(input(owner, async () => new Response("{}", { status: 401 })))).rejects.toMatchObject({ status: 401 });
    expect(owner.capabilities).toBe(0); expect(owner.retention).not.toBe(oldGeneration);
    expect(engine.snapshot()).toMatchObject({ entries: 0, retiredPins: 1, active: 1 });
    owner.capabilities = 63; // A later successful ordinary response can rediscover the current generation.
    await engine.read(input(owner, async () => ok({ values: [3] }, tag2)));
    body.resolve('{"values":[2]}');
    expect(await pending).toEqual({ values: [2] }); // Baseline data availability; no old ledger publication.
    const current = vi.fn(async () => unchanged(tag2));
    expect(await engine.read(input(owner, current))).toEqual({ values: [3] });
    expect(current).toHaveBeenCalledWith(tag2); expect(engine.snapshot().retiredPins).toBe(0);
  });

  it("403 prevents a held old-generation304 using a retired body and allows only one ordinary recovery", async () => {
    const engine = createConditionalApiResponses(), owner = scope(), held = deferred<Response>();
    await engine.read(input(owner, async () => ok({ values: [1] })));
    const ordinary = vi.fn(async () => ({ values: [9] }));
    const pending = engine.read(input(owner, () => held.promise, { ordinary }));
    await expect(engine.read(input(owner, async () => new Response("{}", { status: 403 })))).rejects.toMatchObject({ status: 403 });
    held.resolve(unchanged());
    expect(await pending).toEqual({ values: [9] }); expect(ordinary).toHaveBeenCalledOnce();
    expect(owner.capabilities).toBe(0);
    expect(engine.snapshot()).toEqual({ active: 0, bytes: 0, reserved: 0, entries: 0, liveEntries: 0, retiredPins: 0 });
  });

  it.each([
    [401, "200"], [401, "304"], [403, "200"], [403, "304"],
  ] as const)("ordinary capacity fallback HTTP%s retires a held old%s across rediscovery", async (status, mode) => {
    const engine = createConditionalApiResponses({ limits: { active: 1 } }), owner = scope();
    await engine.read(input(owner, async () => ok({ values: [1] })));
    const generation = owner.retention, began = deferred<void>(), body = deferred<string>(), reply = deferred<Response>();
    const recovery = vi.fn(async () => ({ values: [9] }));
    const pending = engine.read(input(owner, async () => {
      if (mode === "304") { began.resolve(); return reply.promise; }
      const res = ok({ values: [2] });
      Object.defineProperty(res, "text", { value: () => { began.resolve(); return body.promise; } });
      return res;
    }, { ordinary: recovery }));
    await began.promise;
    const fetcher = vi.fn(), ordinary = vi.fn(async () => {
      // The real useApi ordinary path invokes this shared hook at response headers.
      rejectConditionalAuth(owner, "A", status);
      throw Object.assign(new Error("ordinary auth rejection"), { status });
    });
    try {
      await expect(engine.read(input(owner, fetcher, { ordinary }))).rejects.toMatchObject({ status });
      expect(fetcher).not.toHaveBeenCalled(); expect(ordinary).toHaveBeenCalledOnce();
      expect(owner.capabilities).toBe(0); expect(owner.retention).not.toBe(generation);
      expect(engine.snapshot()).toMatchObject({ entries: 0, active: 1, retiredPins: 1 });
      expect(engine.snapshot().bytes).toBeGreaterThan(0); expect(engine.snapshot().reserved).toBeGreaterThan(0);
      owner.capabilities = 63; // An ordinary success can rediscover the new generation.
      body.resolve('{"values":[2]}'); reply.resolve(unchanged());
      expect(await pending).toEqual({ values: [mode === "200" ? 2 : 9] });
      expect(recovery).toHaveBeenCalledTimes(mode === "304" ? 1 : 0);
      expect(engine.snapshot()).toEqual({ active: 0, bytes: 0, reserved: 0, entries: 0, liveEntries: 0, retiredPins: 0 });
      const fresh = vi.fn(async () => ok({ values: [3] }));
      await engine.read(input(owner, fresh)); expect(fresh).toHaveBeenCalledWith(undefined);
    } finally {
      body.resolve('{"values":[2]}'); reply.resolve(unchanged()); await pending.catch(() => undefined);
      retireConditionalScope(owner);
    }
  });

  it("keeps a retired pin and reservation charged across held body work until actual settlement", async () => {
    const engine = createConditionalApiResponses({ limits: { active: 1 } }), owner = scope();
    await engine.read(input(owner, async () => ok({ values: [1] })));
    const body = deferred<string>(), began = deferred<void>();
    const held = engine.read(input(owner, async () => {
      const res = ok({ values: [2] });
      Object.defineProperty(res, "text", { value: () => { began.resolve(); return body.promise; } });
      return res;
    }));
    const outcome = held.catch(error => error); await began.promise;
    retireConditionalScope(owner);
    expect(engine.snapshot()).toMatchObject({ active: 1, retiredPins: 1, entries: 0 });
    expect(engine.snapshot().bytes).toBeGreaterThan(0); expect(engine.snapshot().reserved).toBeGreaterThan(0);
    const next = scope(), fetcher = vi.fn(), ordinary = vi.fn(async () => ({ values: [3] }));
    await engine.read(input(next, fetcher, { ordinary }));
    expect(fetcher).not.toHaveBeenCalled(); expect(ordinary).toHaveBeenCalledOnce();
    body.resolve('{"values":[2]}'); expect(await outcome).toMatchObject({ name: "AbortError" });
    expect(engine.snapshot()).toEqual({ active: 0, bytes: 0, reserved: 0, entries: 0, liveEntries: 0, retiredPins: 0 });
  });

  it("never frees an operation merely because its caller times out or stops awaiting it", async () => {
    const engine = createConditionalApiResponses({ limits: { active: 1 } }), owner = scope(), fetch = deferred<Response>();
    const pending = engine.read(input(owner, () => fetch.promise));
    expect(await Promise.race([pending, Promise.resolve("caller deadline")])).toBe("caller deadline");
    expect(engine.snapshot().active).toBe(1); expect(engine.snapshot().reserved).toBeGreaterThan(0);
    retireConditionalScope(owner); fetch.resolve(ok({ values: [1] }));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(engine.snapshot().active + engine.snapshot().reserved).toBe(0);
  });

  it("admits at most four enhanced operations and never queues the fifth", async () => {
    const engine = createConditionalApiResponses(), owner = scope();
    const held = Array.from({ length: 4 }, () => deferred<Response>());
    const work = held.map((gate, index) => engine.read(input(owner, () => gate.promise, {
      path: `/v1/momentum#${index}`,
    })).catch(error => error));
    expect(engine.snapshot().active).toBe(4);
    const ordinary = vi.fn(async () => ({ values: [5] })), fetcher = vi.fn();
    await engine.read(input(owner, fetcher, { ordinary }));
    expect(fetcher).not.toHaveBeenCalled(); expect(ordinary).toHaveBeenCalledOnce();
    retireConditionalScope(owner);
    expect(engine.snapshot().active).toBe(4);
    held.forEach(gate => gate.resolve(ok({ values: [1] })));
    expect((await Promise.all(work)).every(error => error.name === "AbortError")).toBe(true);
    expect(engine.snapshot().active + engine.snapshot().reserved).toBe(0);
  });

  it("uses one ordinary fetch on pressure before API admission with no enhanced queue", async () => {
    const engine = createConditionalApiResponses({ limits: { bytes: 128 } }), owner = scope();
    const fetcher = vi.fn(), ordinary = vi.fn(async () => ({ values: [5] }));
    expect(await engine.read(input(owner, fetcher, { ordinary }))).toEqual({ values: [5] });
    expect(fetcher).not.toHaveBeenCalled(); expect(ordinary).toHaveBeenCalledOnce();
    expect(engine.snapshot().active + engine.snapshot().reserved + engine.snapshot().bytes).toBe(0);
  });

  it.each([401, 403, 500])("preserves HTTP%s errors and retires private pairs only for auth rejection", async status => {
    const engine = createConditionalApiResponses(), owner = scope();
    await engine.read(input(owner, async () => ok({ values: [1] })));
    await expect(engine.read(input(owner, async () => new Response("{}", { status })))).rejects.toMatchObject({ status });
    expect(engine.snapshot().entries).toBe(status === 500 ? 1 : 0);
    expect(engine.snapshot().active + engine.snapshot().reserved + engine.snapshot().retiredPins).toBe(0);
  });
});
