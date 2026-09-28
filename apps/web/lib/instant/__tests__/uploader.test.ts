import { describe, expect, it, vi } from "vitest";
import { uploadGames, type UploadDeps } from "../uploader";
import { API_BODY_MAX_BYTES } from "../batches";
import { backoffDelayMs, parseRetryAfterMs } from "../httpRetry";

const API = "https://api.test";

interface Call {
  path: string;
  token: string | null;
  body: unknown;
}

type Reply = Response | Error;
type Handler = (call: Call, index: number) => Reply | Promise<Reply>;

/** Mock API: records calls, tracks concurrency, answers via `handlers[path]`. */
function mockApi(handlers: Record<string, Handler>) {
  const calls: Call[] = [];
  const counts: Record<string, number> = {};
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const path = url.replace(API, "");
    const headers = new Headers(init?.headers);
    const auth = headers.get("authorization");
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    const call = { path, token: auth ? auth.replace("Bearer ", "") : null, body };
    calls.push(call);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    inFlight -= 1;
    const index = counts[path] ?? 0;
    counts[path] = index + 1;
    const handler = handlers[path];
    if (!handler) throw new Error(`unexpected ${path}`);
    const reply = await handler(call, index);
    if (reply instanceof Error) throw reply;
    return reply;
  });
  return { fetchImpl, calls, maxInFlight: () => maxInFlight };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function games(n: number, prefix = "g") {
  return Array.from({ length: n }, (_, i) => ({
    gameId: `${prefix}${i}`,
    json: JSON.stringify({ gameId: `${prefix}${i}`, result: "Victory" }),
  }));
}

function idsIn(body: unknown): string[] {
  if (typeof body !== "object" || body === null || !("games" in body) || !Array.isArray(body.games)) return [];
  return body.games.flatMap((g: unknown) =>
    typeof g === "object" && g !== null && "gameId" in g && typeof g.gameId === "string" ? [g.gameId] : [],
  );
}

function existsIds(body: unknown): string[] {
  if (typeof body !== "object" || body === null || !("gameIds" in body) || !Array.isArray(body.gameIds)) return [];
  return body.gameIds.filter((id): id is string => typeof id === "string");
}

function acceptAll(call: Call): Response {
  return json(202, { accepted: idsIn(call.body).map((gameId) => ({ gameId, created: true })), rejected: [] });
}

const noneExist: Handler = () => json(200, { existing: [] });

function deps(fetchImpl: typeof fetch, extra: Partial<UploadDeps> = {}): UploadDeps {
  let n = 0;
  return {
    getToken: async () => `t${++n}`,
    apiBase: API,
    engineVersion: "1.6.3",
    fetchImpl,
    sleep: vi.fn(async () => {}),
    random: () => 0,
    now: () => Date.parse("2026-09-27T12:00:00Z"),
    ...extra,
  };
}

const gamesCalls = (calls: Call[]) => calls.filter((c) => c.path === "/v1/games");

describe("uploadGames: existence check", () => {
  it("skips games the account already has and tags the rest", async () => {
    const api = mockApi({ "/v1/games/exists": () => json(200, { existing: ["g1"] }), "/v1/games": acceptAll });
    const summary = await uploadGames(games(3), deps(api.fetchImpl));
    expect(summary.skippedExisting).toEqual(["g1"]);
    expect(summary.accepted.map((a) => a.gameId)).toEqual(["g0", "g2"]);
    const [upload] = gamesCalls(api.calls);
    expect(idsIn(upload.body)).toEqual(["g0", "g2"]);
    expect(upload.body).toMatchObject({ games: [{ ingestSource: "browser", engineVersion: "1.6.3" }, {}] });
    expect(summary.pending).toEqual([]);
    expect(summary.stoppedReason).toBeUndefined();
  });

  it("checks existence in chunks of 500 with a fresh token each", async () => {
    const api = mockApi({ "/v1/games/exists": noneExist, "/v1/games": acceptAll });
    await uploadGames(games(1200), deps(api.fetchImpl));
    const exists = api.calls.filter((c) => c.path === "/v1/games/exists");
    expect(exists.map((c) => existsIds(c.body).length)).toEqual([500, 500, 200]);
    expect(new Set(exists.map((c) => c.token)).size).toBe(3);
  });

  it("uploads everything when the lookup is unavailable", async () => {
    const api = mockApi({ "/v1/games/exists": () => json(500, {}), "/v1/games": acceptAll });
    const summary = await uploadGames(games(2), deps(api.fetchImpl));
    expect(summary.accepted).toHaveLength(2);
  });

  it("dedupes repeated gameIds", async () => {
    const api = mockApi({ "/v1/games/exists": noneExist, "/v1/games": acceptAll });
    const summary = await uploadGames([...games(2), ...games(2)], deps(api.fetchImpl));
    expect(idsIn(gamesCalls(api.calls)[0].body)).toEqual(["g0", "g1"]);
    expect(summary.accepted).toHaveLength(2);
  });
});

describe("uploadGames: batching", () => {
  it("uploads one batch at a time with a fresh token per batch", async () => {
    const api = mockApi({ "/v1/games/exists": noneExist, "/v1/games": acceptAll });
    const summary = await uploadGames(games(120), deps(api.fetchImpl));
    const uploads = gamesCalls(api.calls);
    expect(uploads.map((c) => idsIn(c.body).length)).toEqual([50, 50, 20]);
    expect(api.maxInFlight()).toBe(1);
    const tokens = uploads.map((c) => c.token);
    expect(new Set(tokens).size).toBe(tokens.length);
    expect(summary.accepted).toHaveLength(120);
  });

  it("reports oversized games and invalid JSON without sending them", async () => {
    const api = mockApi({ "/v1/games/exists": noneExist, "/v1/games": acceptAll });
    const big = { gameId: "big", json: `{"gameId":"big","pad":"${"x".repeat(API_BODY_MAX_BYTES)}"}` };
    const bad = { gameId: "bad", json: "not json" };
    const summary = await uploadGames([big, bad, ...games(1)], deps(api.fetchImpl));
    expect(summary.oversized).toEqual(["big"]);
    expect(summary.rejected).toEqual([{ gameId: "bad", errors: ["invalid_game_json"] }]);
    expect(idsIn(gamesCalls(api.calls)[0].body)).toEqual(["g0"]);
  });
});

describe("uploadGames: retries", () => {
  it("honours Retry-After on 503 replay_ingest_busy, then retries the same batch", async () => {
    const busy = { error: { code: "replay_ingest_busy", retryable: true } };
    const api = mockApi({
      "/v1/games/exists": noneExist,
      "/v1/games": (call, i) => (i === 0 ? json(503, busy, { "retry-after": "7" }) : acceptAll(call)),
    });
    const d = deps(api.fetchImpl);
    const progress = vi.fn();
    const summary = await uploadGames(games(3), { ...d, onProgress: progress });
    expect(d.sleep).toHaveBeenCalledWith(7000, undefined);
    const uploads = gamesCalls(api.calls);
    expect(uploads).toHaveLength(2);
    expect(uploads[1].body).toEqual(uploads[0].body);
    expect(uploads[1].token).not.toBe(uploads[0].token);
    expect(summary.accepted).toHaveLength(3);
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ phase: "waiting", retryInMs: 7000 }));
  });

  it("falls back to 5 s when Retry-After is not readable (CORS)", async () => {
    const api = mockApi({
      "/v1/games/exists": noneExist,
      "/v1/games": (call, i) => (i === 0 ? json(503, { error: { code: "replay_ingest_busy" } }) : acceptAll(call)),
    });
    const d = deps(api.fetchImpl);
    await uploadGames(games(1), d);
    expect(d.sleep).toHaveBeenCalledWith(5000, undefined);
  });
});

describe("uploadGames: backoff", () => {
  it("backs off exponentially with full jitter, capped at 60 s, then stops", async () => {
    const api = mockApi({ "/v1/games/exists": noneExist, "/v1/games": () => json(500, {}) });
    const sleep = vi.fn(async (_ms: number) => {});
    const summary = await uploadGames(games(2), deps(api.fetchImpl, { random: () => 0.999, sleep }));
    const waits = sleep.mock.calls.map((c) => c[0]);
    expect(waits).toEqual([999, 1998, 3996, 7992, 15984, 31968, 59940]);
    expect(gamesCalls(api.calls)).toHaveLength(8);
    expect(summary.stoppedReason).toBe("server");
    expect(summary.pending).toEqual(["g0", "g1"]);
  });

  it("uses the full-jitter formula (random 0 means immediate retry)", () => {
    expect(backoffDelayMs(0, { baseMs: 1000, capMs: 60_000, random: () => 0 })).toBe(0);
    expect(backoffDelayMs(10, { baseMs: 1000, capMs: 60_000, random: () => 1 })).toBe(60_000);
    expect(backoffDelayMs(0, { baseMs: 1000, capMs: 60_000, random: () => 0, retryAfterMs: 120_000 })).toBe(60_000);
    expect(parseRetryAfterMs("Sun, 27 Sep 2026 12:00:09 GMT", Date.parse("2026-09-27T12:00:00Z"))).toBe(9000);
    expect(parseRetryAfterMs("soon", 0)).toBeNull();
  });

  it("ignores numeric Retry-After values that are not whole seconds", () => {
    // V8's Date.parse reads these as year-2001 dates, which would turn into
    // a 0 ms wait and disable the busy-slot fallback.
    for (const junk of ["1.5", "-1", "+5", "1e3"]) {
      expect(parseRetryAfterMs(junk, Date.parse("2026-09-27T12:00:00Z"))).toBeNull();
    }
    expect(parseRetryAfterMs(" 7 ", 0)).toBe(7000);
  });

  it("retries network errors", async () => {
    const api = mockApi({
      "/v1/games/exists": noneExist,
      "/v1/games": (call, i) => (i === 0 ? new TypeError("Failed to fetch") : acceptAll(call)),
    });
    const summary = await uploadGames(games(1), deps(api.fetchImpl));
    expect(summary.accepted).toHaveLength(1);
  });

  it("retries 429 without the daily-cap code", async () => {
    const api = mockApi({
      "/v1/games/exists": noneExist,
      "/v1/games": (call, i) => (i === 0 ? new Response("Too many requests", { status: 429 }) : acceptAll(call)),
    });
    const summary = await uploadGames(games(1), deps(api.fetchImpl));
    expect(summary.accepted).toHaveLength(1);
  });
});

describe("uploadGames: auth", () => {
  it("refreshes the token once on 401", async () => {
    const api = mockApi({
      "/v1/games/exists": noneExist,
      "/v1/games": (call, i) => (i === 0 ? json(401, { error: { code: "invalid_token" } }) : acceptAll(call)),
    });
    const getToken = vi.fn(async (_options?: { skipCache?: boolean }) => "tok");
    const d = deps(api.fetchImpl, { getToken });
    const summary = await uploadGames(games(1), d);
    expect(summary.accepted).toHaveLength(1);
    expect(d.sleep).not.toHaveBeenCalled();
    // exists, upload (401), upload again with a freshly minted token.
    expect(getToken.mock.calls.map((c) => c[0])).toEqual([undefined, undefined, { skipCache: true }]);
  });

  it("refreshes the token once for the existence check too", async () => {
    const api = mockApi({
      "/v1/games/exists": (_call, i) => (i === 0 ? json(401, {}) : json(200, { existing: ["g0"] })),
      "/v1/games": acceptAll,
    });
    const getToken = vi.fn(async (_options?: { skipCache?: boolean }) => "tok");
    const summary = await uploadGames(games(2), deps(api.fetchImpl, { getToken }));
    expect(summary.skippedExisting).toEqual(["g0"]);
    expect(getToken.mock.calls[1][0]).toEqual({ skipCache: true });
  });

  it("stops with auth after a second 401", async () => {
    const api = mockApi({ "/v1/games/exists": noneExist, "/v1/games": () => json(401, {}) });
    const summary = await uploadGames(games(2), deps(api.fetchImpl));
    expect(summary.stoppedReason).toBe("auth");
    expect(gamesCalls(api.calls)).toHaveLength(2);
    expect(summary.pending).toEqual(["g0", "g1"]);
  });

  it("stops with auth when signed out", async () => {
    const api = mockApi({});
    const summary = await uploadGames(games(1), deps(api.fetchImpl, { getToken: async () => null }));
    expect(summary.stoppedReason).toBe("auth");
    expect(api.calls).toHaveLength(0);
  });
});

describe("uploadGames: daily cap", () => {
  it("stops at the browser daily cap without retrying", async () => {
    const cap = { error: { code: "browser_ingest_daily_cap", retryable: false, limit: 500 } };
    const api = mockApi({
      "/v1/games/exists": noneExist,
      "/v1/games": () => json(429, cap, { "retry-after": "3600" }),
    });
    const summary = await uploadGames(games(3), deps(api.fetchImpl));
    expect(summary.stoppedReason).toBe("daily_cap");
    expect(gamesCalls(api.calls)).toHaveLength(1);
    expect(summary.pending).toEqual(["g0", "g1", "g2"]);
  });

  it("sends the games that still fit today as one smaller batch, then stops", async () => {
    // apps/api gamesIngestPolicy: the whole batch is refused when it would cross the cap,
    // and `remaining` says how many games still fit.
    const cap = { error: { code: "browser_ingest_daily_cap", retryable: false, limit: 5000, remaining: 3 } };
    const api = mockApi({
      "/v1/games/exists": noneExist,
      "/v1/games": (call) => (idsIn(call.body).length > 3 ? json(429, cap, { "retry-after": "3600" }) : acceptAll(call)),
    });
    const d = deps(api.fetchImpl);
    const summary = await uploadGames(games(60), d);
    expect(gamesCalls(api.calls).map((c) => idsIn(c.body).length)).toEqual([50, 3]);
    expect(summary.accepted.map((a) => a.gameId)).toEqual(["g0", "g1", "g2"]);
    expect(summary.stoppedReason).toBe("daily_cap");
    expect(summary.pending).toHaveLength(57);
    expect(summary.pending[0]).toBe("g3");
    expect(d.sleep).not.toHaveBeenCalled();
  });

  it("stops at once when nothing fits, and never shrinks twice", async () => {
    const capWith = (remaining: number) => ({ error: { code: "browser_ingest_daily_cap", remaining } });
    const none = mockApi({ "/v1/games/exists": noneExist, "/v1/games": () => json(429, capWith(0)) });
    const nothing = await uploadGames(games(5), deps(none.fetchImpl));
    expect(gamesCalls(none.calls)).toHaveLength(1);
    expect(nothing).toMatchObject({ stoppedReason: "daily_cap", accepted: [] });
    // Another tab used the quota meanwhile: the cap-sized batch is refused too.
    const racing = mockApi({ "/v1/games/exists": noneExist, "/v1/games": () => json(429, capWith(2)) });
    const raced = await uploadGames(games(5), deps(racing.fetchImpl));
    expect(gamesCalls(racing.calls).map((c) => idsIn(c.body).length)).toEqual([5, 2]);
    expect(raced.stoppedReason).toBe("daily_cap");
    expect(raced.pending).toHaveLength(5);
  });
});

describe("uploadGames: abort", () => {
  it("stops when aborted while waiting to retry", async () => {
    const controller = new AbortController();
    const api = mockApi({ "/v1/games/exists": noneExist, "/v1/games": () => json(503, {}) });
    const sleep = vi.fn(async () => {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    });
    const summary = await uploadGames(games(1), deps(api.fetchImpl, { sleep, signal: controller.signal }));
    expect(summary.stoppedReason).toBe("aborted");
    expect(summary.pending).toEqual(["g0"]);
  });

  it("does nothing once already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const api = mockApi({});
    const summary = await uploadGames(games(1), deps(api.fetchImpl, { signal: controller.signal }));
    expect(summary.stoppedReason).toBe("aborted");
    expect(api.calls).toHaveLength(0);
  });
});

describe("uploadGames: response handling", () => {
  it("splits a batch in half on 413 and rejects a single oversized game", async () => {
    const api = mockApi({
      "/v1/games/exists": noneExist,
      "/v1/games": (call) => {
        const ids = idsIn(call.body);
        return ids.length > 2 || ids.includes("g3") ? json(413, {}) : acceptAll(call);
      },
    });
    const summary = await uploadGames(games(4), deps(api.fetchImpl));
    expect(gamesCalls(api.calls).map((c) => idsIn(c.body))).toEqual([
      ["g0", "g1", "g2", "g3"],
      ["g0", "g1"],
      ["g2", "g3"],
      ["g2"],
      ["g3"],
    ]);
    expect(summary.accepted.map((a) => a.gameId)).toEqual(["g0", "g1", "g2"]);
    expect(summary.rejected).toEqual([{ gameId: "g3", errors: ["payload_too_large"] }]);
  });
});

describe("uploadGames: per-game results", () => {
  it("requeues retryable and missing games once, into a later batch", async () => {
    const api = mockApi({
      "/v1/games/exists": noneExist,
      "/v1/games": (_call, i) =>
        i === 0
          ? json(202, {
              accepted: [{ gameId: "g0", created: true, replayArchive: { available: false } }],
              rejected: [
                { gameId: "g1", errors: ["upsert_failed"], retryable: true },
                { gameId: "g2", errors: ["/result must be equal to one of the allowed values"] },
              ],
            })
          : json(202, {
              accepted: [{ gameId: "g1", created: false }],
              rejected: [{ gameId: "g3", errors: ["custom_build_tag_retry_required"], retryable: true }],
            }),
    });
    const summary = await uploadGames(games(4), deps(api.fetchImpl));
    const uploads = gamesCalls(api.calls);
    expect(uploads.map((c) => idsIn(c.body))).toEqual([["g0", "g1", "g2", "g3"], ["g1", "g3"]]);
    expect(summary.accepted).toEqual([
      { gameId: "g0", created: true, replayArchive: { available: false } },
      { gameId: "g1", created: false },
    ]);
    expect(summary.rejected).toEqual([
      { gameId: "g2", errors: ["/result must be equal to one of the allowed values"] },
      { gameId: "g3", errors: ["custom_build_tag_retry_required"] },
    ]);
    expect(summary.pending).toEqual([]);
  });

  it("rejects a batch the server refuses as a bad request", async () => {
    const api = mockApi({
      "/v1/games/exists": noneExist,
      "/v1/games": () => json(400, { error: { code: "bad_request" } }),
    });
    const summary = await uploadGames(games(2), deps(api.fetchImpl));
    expect(summary.rejected).toEqual([
      { gameId: "g0", errors: ["bad_request"] },
      { gameId: "g1", errors: ["bad_request"] },
    ]);
  });
});
