import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIXTURE_INDEX } from "../guides/__fixtures__/hub";
import { guideMapPath } from "../guides/slugs";
import {
  COMMAND_GUIDE_METADATA_BYTES, COMMAND_GUIDE_METADATA_PATHS,
  loadCommandGuideMetadata, resetCommandGuideMetadataCache,
} from "../commandGuideMetadata";

vi.mock("../clientApi", () => ({ API_BASE: "https://api.sc2tools.test" }));
const BASE = "https://api.sc2tools.test", AT = "2026-10-27T12:00:00.000Z";
const SITEMAP = "/v1/guides/sitemap", INDEX = "/v1/guides";
const fetching = vi.fn<typeof fetch>();
type ResponseOptions = {
  body?: BodyInit | null; headers?: Record<string, string>; status?: number;
  url?: string; redirected?: boolean;
};

function response(path: string, value: unknown, options: ResponseOptions = {}): Response {
  const result = new Response(Object.hasOwn(options, "body") ? options.body : JSON.stringify(value), {
    status: options.status ?? 200, headers: { "content-type": "application/json", ...options.headers },
  });
  Object.defineProperties(result, {
    url: { value: options.url ?? `${BASE}${path}` }, redirected: { value: options.redirected ?? false },
  });
  return result;
}
function sitemap(paths: readonly string[] = ["/guides", "/guides/maps", "/guides/pvz/counter", "/guides/pvz/counter/12-pool"]) {
  return { computedAt: AT, entries: paths.map(path => ({ path, lastModified: AT })) };
}
function index(maps: unknown = FIXTURE_INDEX.maps) { return { ...FIXTURE_INDEX, maps }; }
function serve(sitemapBody: unknown = sitemap(), indexBody: unknown = index()) {
  fetching.mockImplementation(async input => String(input) === `${BASE}${SITEMAP}`
    ? response(SITEMAP, sitemapBody) : response(INDEX, indexBody));
}
function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error("not initialized"); };
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
function openBody(bytes?: Uint8Array) {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) { if (bytes) controller.enqueue(bytes); }, cancel,
  });
  return { body, cancel };
}

beforeEach(() => { resetCommandGuideMetadataCache(); fetching.mockReset(); vi.stubGlobal("fetch", fetching); serve(); });
afterEach(() => { resetCommandGuideMetadataCache(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("one anonymous public metadata catalog", () => {
  it("uses only the two existing routes with credentials omitted and no authenticated helpers", async () => {
    const maps = [{ ...FIXTURE_INDEX.maps[0], privatePlayer: "do not index", privateUrl: "/guides/me/secret" }];
    serve(sitemap(), index(maps));
    const result = await loadCommandGuideMetadata();
    expect(fetching.mock.calls.map(([url]) => String(url))).toEqual([`${BASE}${SITEMAP}`, `${BASE}${INDEX}`]);
    for (const [, init] of fetching.mock.calls) {
      expect(init).toMatchObject({ method: "GET", credentials: "omit", redirect: "error", cache: "no-store" });
      expect(new Headers(init?.headers).get("authorization")).toBeNull();
      expect(new Headers(init?.headers).get("cookie")).toBeNull();
    }
    expect(new Headers(fetching.mock.calls[1][1]?.headers).get("x-sc2tools-guide-index-version")).toBe("2");
    expect(result.publishedPaths.has("/guides/maps")).toBe(true);
    expect(result.maps).toEqual([{ map: maps[0].map, slug: maps[0].slug }]);
    expect(JSON.stringify(result.maps)).not.toMatch(/private|do not index|secret/);
  });

  it("shares one flight and one successful six-hour catalog across repeated opens", async () => {
    vi.useFakeTimers();
    const a = deferred<Response>(), b = deferred<Response>();
    fetching.mockImplementation(input => String(input).endsWith("/sitemap") ? a.promise : b.promise);
    const readers = Array.from({ length: 12 }, () => loadCommandGuideMetadata());
    expect(fetching).toHaveBeenCalledTimes(2);
    a.resolve(response(SITEMAP, sitemap())); b.resolve(response(INDEX, index()));
    const results = await Promise.all(readers);
    expect(results.every(value => value === results[0])).toBe(true);
    vi.advanceTimersByTime(21600 * 1000 - 1);
    expect(await loadCommandGuideMetadata()).toBe(results[0]); expect(fetching).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1); serve();
    expect(await loadCommandGuideMetadata()).not.toBe(results[0]); expect(fetching).toHaveBeenCalledTimes(4);
  });

  it("does not treat failure as success or start another request without explicit Retry", async () => {
    fetching.mockImplementation(async input => response(String(input).endsWith("/sitemap") ? SITEMAP : INDEX, {}, { status: 503 }));
    await expect(loadCommandGuideMetadata()).rejects.toThrow();
    serve(); await expect(loadCommandGuideMetadata()).rejects.toThrow(); expect(fetching).toHaveBeenCalledTimes(2);
    expect((await loadCommandGuideMetadata({ force: true })).maps).toHaveLength(FIXTURE_INDEX.maps.length);
    expect(fetching).toHaveBeenCalledTimes(4);
  });

  it("does not return a previous success after an explicit refresh fails", async () => {
    await loadCommandGuideMetadata();
    fetching.mockRejectedValue(new Error("offline"));
    await expect(loadCommandGuideMetadata({ force: true })).rejects.toThrow("offline");
    serve(); await expect(loadCommandGuideMetadata()).rejects.toThrow("offline");
    expect(fetching).toHaveBeenCalledTimes(4);
    await loadCommandGuideMetadata({ force: true }); expect(fetching).toHaveBeenCalledTimes(6);
  });
});

describe("actual public payload admission", () => {
  it("admits all 5,011 finite server paths and 200 maps below the streamed byte ceiling", async () => {
    const matchups = ["pvp", "pvt", "pvz", "tvp", "tvt", "tvz", "zvp", "zvt", "zvz"];
    const counterPaths = Array.from({ length: 4999 }, (_, i) => `/guides/${matchups[i % 9]}/counter/${String(i).padStart(4, "0")}-${"a".repeat(75)}`);
    const headings = matchups.map(mu => `/guides/${mu}/counter`);
    const body = sitemap([...counterPaths, "/guides/maps/published-map-0", "/guides", "/guides/maps", ...headings]);
    const maps = Array.from({ length: 200 }, (_, i) => ({ map: `Published map ${i}`, slug: `published-map-${i}`, games: 100 }));
    expect(body.entries).toHaveLength(5011); expect(COMMAND_GUIDE_METADATA_PATHS).toBe(5011);
    expect(new TextEncoder().encode(JSON.stringify(body)).length).toBeLessThan(1024 * 1024);
    serve(body, index(maps)); const result = await loadCommandGuideMetadata();
    expect(result.publishedPaths.size).toBe(5011); expect(result.maps).toHaveLength(200);
    expect(result.maps.at(-1)).toEqual({ map: "Published map 199", slug: "published-map-199" });
  });

  it.each([
    null, {}, { entries: [] }, { computedAt: "invalid", entries: [] },
    { computedAt: AT, entries: "bad" }, { computedAt: AT, entries: [{ path: "/guides", lastModified: null }] },
  ])("rejects an unknown sitemap schema rather than assuming an empty publication set", async body => {
    serve(body); await expect(loadCommandGuideMetadata()).rejects.toThrow();
  });

  it.each([
    "https://foreign.test/guides/pvz/12-pool", "//foreign.test/guides", "/guides/pvz/12-pool?token=x",
    "/guides/pvz/12-pool#fragment", "/guides/me/pvz/secret", "/guides/maps/%2e%2e",
    "/guides/PvZ/12-pool", `/guides/maps/${"a".repeat(81)}`, "/guides\n",
  ])("rejects unsafe sitemap path %s without dropping only the offending row", async path => {
    serve(sitemap(["/guides", path])); await expect(loadCommandGuideMetadata()).rejects.toThrow();
  });

  it("rejects entry overflow and duplicate publication paths instead of silently truncating", async () => {
    serve(sitemap(Array.from({ length: 5012 }, (_, i) => `/guides/maps/map-${i}`)));
    await expect(loadCommandGuideMetadata()).rejects.toThrow();
    serve(sitemap(["/guides", "/guides"])); await expect(loadCommandGuideMetadata({ force: true })).rejects.toThrow();
  });

  it.each([
    null, { maps: [] }, { ...FIXTURE_INDEX, maps: {} }, { ...FIXTURE_INDEX, era: ["after"] },
    { ...FIXTURE_INDEX, computedAt: "invalid" }, { ...FIXTURE_INDEX, matchups: null },
    { ...FIXTURE_INDEX, videos: null }, { ...FIXTURE_INDEX, channel: "unknown" },
  ])("rejects an unknown guide-index schema", async body => {
    serve(sitemap(), body); await expect(loadCommandGuideMetadata()).rejects.toThrow();
  });

  it.each([
    { map: "Valid LE", slug: "valid-le" }, { map: "Valid LE", slug: "//foreign.test", games: 40 },
    { map: "Bad\nName", slug: "bad-name", games: 40 }, { map: " ", slug: "empty", games: 40 },
    { map: "a".repeat(201), slug: "a".repeat(80), games: 40 }, { map: "Valid LE", slug: "valid-le", games: Infinity },
  ])("rejects malformed map metadata as a whole unavailable catalog", async row => {
    serve(sitemap(), index([FIXTURE_INDEX.maps[0], row])); await expect(loadCommandGuideMetadata()).rejects.toThrow();
  });

  it("keeps the full bounded Unicode map name and rejects map count overflow/duplicates", async () => {
    const name = `Map ${"é".repeat(196)}`, slug = guideMapPath(name)!.slice("/guides/maps/".length);
    serve(sitemap(), index([{ map: name, slug, games: 100 }]));
    expect((await loadCommandGuideMetadata()).maps[0]).toEqual({ map: name, slug });
    serve(sitemap(), index(Array.from({ length: 201 }, (_, i) => ({ map: `Map ${i}`, slug: `map-${i}`, games: 40 }))));
    await expect(loadCommandGuideMetadata({ force: true })).rejects.toThrow();
    serve(sitemap(), index([FIXTURE_INDEX.maps[0], FIXTURE_INDEX.maps[0]]));
    await expect(loadCommandGuideMetadata({ force: true })).rejects.toThrow();
  });
});

describe("bounded anonymous transport", () => {
  it.each<ResponseOptions>([
    { status: 302, headers: { location: "https://foreign.test/" } },
    { redirected: true }, { url: "https://foreign.test/v1/guides/sitemap" },
    { url: `${BASE}/v1/guides/sitemap?token=unexpected` }, { headers: { "content-type": "text/html" } },
  ])("denies redirects, changed response URLs and non-JSON bodies", async options => {
    const stream = openBody();
    fetching.mockImplementation(async input => String(input).endsWith("/sitemap")
      ? response(SITEMAP, null, { ...options, body: stream.body }) : response(INDEX, index()));
    await expect(loadCommandGuideMetadata()).rejects.toThrow(); expect(stream.cancel).toHaveBeenCalledTimes(1);
  });

  it("rejects a claimed oversized response and cancels its actual unread body", async () => {
    const stream = openBody();
    fetching.mockImplementation(async input => String(input).endsWith("/sitemap")
      ? response(SITEMAP, null, { body: stream.body, headers: { "content-length": "1048577" } }) : response(INDEX, index()));
    await expect(loadCommandGuideMetadata()).rejects.toThrow(); expect(stream.cancel).toHaveBeenCalledTimes(1);
    expect(stream.body.locked).toBe(false);
  });

  it.each([undefined, "8"])("enforces streamed bytes with absent or lying Content-Length=%s", async length => {
    const stream = openBody(new Uint8Array(1024 * 1024 + 1));
    fetching.mockImplementation(async input => String(input).endsWith("/sitemap")
      ? response(SITEMAP, null, { body: stream.body, headers: length ? { "content-length": length } : {} }) : response(INDEX, index()));
    await expect(loadCommandGuideMetadata()).rejects.toThrow(); expect(stream.cancel).toHaveBeenCalledTimes(1);
    expect(stream.body.locked).toBe(false);
  });

  it("accepts exactly one MiB of valid UTF-8 JSON including trailing whitespace", async () => {
    const body = JSON.stringify(sitemap()).padEnd(1024 * 1024, " ");
    expect(new TextEncoder().encode(body).length).toBe(COMMAND_GUIDE_METADATA_BYTES);
    fetching.mockImplementation(async input => String(input).endsWith("/sitemap")
      ? response(SITEMAP, null, { body }) : response(INDEX, index()));
    expect((await loadCommandGuideMetadata()).publishedPaths.has("/guides")).toBe(true);
  });

  it("rejects truncated UTF-8 or JSON and releases actual reader locks", async () => {
    const broken = new Response(new Uint8Array([0xc3]), { headers: { "content-type": "application/json" } });
    Object.defineProperty(broken, "url", { value: `${BASE}${SITEMAP}` });
    fetching.mockImplementation(async input => String(input).endsWith("/sitemap") ? broken : response(INDEX, index()));
    await expect(loadCommandGuideMetadata()).rejects.toThrow(); expect(broken.body?.locked).toBe(false);
    fetching.mockImplementation(async input => String(input).endsWith("/sitemap") ? response(SITEMAP, null, { body: "{\"entries\":" }) : response(INDEX, index()));
    await expect(loadCommandGuideMetadata({ force: true })).rejects.toThrow();
  });

  it("cancels/relinquishes the actual body on a stream read rejection", async () => {
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("read failed")); } });
    const cancel = vi.spyOn(body, "cancel");
    fetching.mockImplementation(async input => String(input).endsWith("/sitemap") ? response(SITEMAP, null, { body }) : response(INDEX, index()));
    await expect(loadCommandGuideMetadata()).rejects.toThrow("read failed");
    expect(cancel).toHaveBeenCalled(); expect(body.locked).toBe(false);
  });
});

describe("consumer cancellation, deadline and late completion", () => {
  it("does not start requests for an already canceled consumer", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(loadCommandGuideMetadata({ signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetching).not.toHaveBeenCalled();
  });

  it("keeps a shared flight for another consumer when one closes", async () => {
    const a = deferred<Response>(), b = deferred<Response>(), controller = new AbortController();
    fetching.mockImplementation(input => String(input).endsWith("/sitemap") ? a.promise : b.promise);
    const canceled = loadCommandGuideMetadata({ signal: controller.signal }), peer = loadCommandGuideMetadata();
    controller.abort(); await expect(canceled).rejects.toMatchObject({ name: "AbortError" });
    expect(fetching.mock.calls.every(([, init]) => !init?.signal?.aborted)).toBe(true);
    a.resolve(response(SITEMAP, sitemap())); b.resolve(response(INDEX, index()));
    expect((await peer).maps.length).toBeGreaterThan(0); expect(fetching).toHaveBeenCalledTimes(2);
  });

  it("cancels the actual reader when the last consumer closes", async () => {
    const controller = new AbortController(), stream = openBody();
    fetching.mockImplementation(async input => String(input).endsWith("/sitemap") ? response(SITEMAP, null, { body: stream.body }) : response(INDEX, index()));
    const pending = loadCommandGuideMetadata({ signal: controller.signal }); await flush();
    expect(stream.body.locked).toBe(true); controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" }); await flush();
    expect(stream.cancel).toHaveBeenCalledTimes(1); expect(stream.body.locked).toBe(false);
    serve(); await loadCommandGuideMetadata(); expect(fetching).toHaveBeenCalledTimes(4);
  });

  it("cancels ignored-abort late responses without poisoning a newer successful flight", async () => {
    const a = deferred<Response>(), b = deferred<Response>(), controller = new AbortController();
    fetching.mockImplementation(input => String(input).endsWith("/sitemap") ? a.promise : b.promise);
    const old = loadCommandGuideMetadata({ signal: controller.signal }); controller.abort();
    await expect(old).rejects.toMatchObject({ name: "AbortError" });
    serve(sitemap(["/guides/pvz"])); const fresh = await loadCommandGuideMetadata();
    const lateA = openBody(), lateB = openBody();
    a.resolve(response(SITEMAP, null, { body: lateA.body })); b.resolve(response(INDEX, null, { body: lateB.body })); await flush();
    expect(lateA.cancel).toHaveBeenCalledTimes(1); expect(lateB.cancel).toHaveBeenCalledTimes(1);
    expect(await loadCommandGuideMetadata()).toBe(fresh);
    expect([...fresh.publishedPaths]).toEqual(["/guides/pvz"]); expect(fetching).toHaveBeenCalledTimes(4);
  });

  it("enforces one six-second total deadline during a pending read and requires Retry", async () => {
    vi.useFakeTimers(); const stream = openBody();
    fetching.mockImplementation(async input => String(input).endsWith("/sitemap") ? response(SITEMAP, null, { body: stream.body }) : response(INDEX, index()));
    const pending = loadCommandGuideMetadata(), rejected = expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(5999); expect(stream.cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); await rejected; await flush();
    expect(stream.cancel).toHaveBeenCalledTimes(1); expect(stream.body.locked).toBe(false);
    serve(); await expect(loadCommandGuideMetadata()).rejects.toMatchObject({ name: "TimeoutError" });
    expect(fetching).toHaveBeenCalledTimes(2);
    await loadCommandGuideMetadata({ force: true }); expect(fetching).toHaveBeenCalledTimes(4);
  });

  it("times out an ignored-abort fetch and retires its eventual body", async () => {
    vi.useFakeTimers(); const late = deferred<Response>();
    fetching.mockImplementation(input => String(input).endsWith("/sitemap") ? late.promise : Promise.resolve(response(INDEX, index())));
    const pending = loadCommandGuideMetadata(), rejected = expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(6000); await rejected;
    const stream = openBody(); late.resolve(response(SITEMAP, null, { body: stream.body })); await flush();
    expect(stream.cancel).toHaveBeenCalledTimes(1); expect(fetching.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });
});
