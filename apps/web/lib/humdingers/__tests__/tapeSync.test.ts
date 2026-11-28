// @vitest-environment node
// Node has CompressionStream, Blob.stream() and Response, which the gzip helpers need.
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { TokenCache } from "../saveSync";
import {
  KEEPALIVE_MAX_BYTES, TapeUploader, decodeChunks, gunzipBase64, gzipBase64, tapeSource,
  type TapeChunk, type TapeSource, type TapeUpload,
} from "../tapeSync";

const chunk = (seq: number, extra: Partial<TapeChunk> = {}): TapeChunk =>
  ({ v: 1, seq, build: "19bbccd577ad", seed: 7, admin: false, from: seq * 100, to: seq * 100 + 100, inp: [3, 1, 4], ev: [], ...extra });

function game(chunks: Array<TapeChunk | null>): TapeSource & { taken: number } {
  const queue = [...chunks];
  return {
    taken: 0,
    take() { this.taken += 1; return queue.length ? queue.shift() ?? null : null; },
    summary: () => ({ ticks: 600, fights: 2, won: 1, goal: "Find the humming." }),
  };
}

let fetchMock: Mock;
let status = 204;
const posts = () => fetchMock.mock.calls.map(([url, init]) => ({ url: String(url), init: init as RequestInit, body: JSON.parse(String((init as RequestInit).body)) as TapeUpload }));

beforeEach(() => {
  status = 204;
  fetchMock = vi.fn(async () => new Response(null, { status }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("gzip helpers", () => {
  it("round-trips text through gzip and base64", async () => {
    const text = JSON.stringify(chunk(3, { kv: [[0, "save.0", "x".repeat(5_000)]] }));
    const packed = await gzipBase64(text);
    expect(packed).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(packed.length).toBeLessThan(text.length / 4);
    expect(await gunzipBase64(packed)).toBe(text);
  });

  it("decodes stored chunks in order and skips a damaged one", async () => {
    const rows = [
      { seq: 2, enc: "json", data: JSON.stringify(chunk(2)), from: 200, to: 300 },
      { seq: 0, enc: "gzip-b64", data: await gzipBase64(JSON.stringify(chunk(0))), from: 0, to: 100 },
      { seq: 1, enc: "gzip-b64", data: "not gzip", from: 100, to: 200 },
    ];
    const decoded = await decodeChunks(rows);
    expect(decoded.map((c) => c.seq)).toEqual([0, 2]);
  });
});

describe("tapeSource", () => {
  it("finds the game's tape in a frame window, or nothing", () => {
    const tape = game([]);
    expect(tapeSource({ G: { tape } } as unknown as Window)).toBe(tape);
    expect(tapeSource({} as Window)).toBeNull();
    expect(tapeSource(null)).toBeNull();
    expect(tapeSource({ G: { tape: { take: () => null } } } as unknown as Window)).toBeNull();
  });
});

describe("TapeUploader", () => {
  const tokens = () => new TokenCache(async () => "token-1");

  it("gzips the game's new chunk and posts it with the visit's session and summary", async () => {
    const source = game([chunk(0)]);
    const uploader = new TapeUploader(tokens(), "visit-1234", () => source);
    await uploader.pull();
    const [post] = posts();
    expect(post.url).toMatch(/\/v1\/me\/humdingers\/tapes\/visit-1234$/);
    expect(post.init.method).toBe("POST");
    expect(post.body).toMatchObject({ seq: 0, enc: "gzip-b64", build: "19bbccd577ad", from: 0, to: 100, summary: { fights: 2, goal: "Find the humming." } });
    expect(post.body.final).toBeUndefined();
    expect(JSON.parse(await gunzipBase64(post.body.data))).toEqual(chunk(0));
    expect(uploader.pending).toBe(0);
    await uploader.pull();
    expect(fetchMock).toHaveBeenCalledTimes(1);   // nothing new: nothing sent
  });

  it("keeps a chunk the network lost and sends it first next time; drops one the API refuses", async () => {
    const source = game([chunk(0), chunk(1), chunk(2)]);
    const uploader = new TapeUploader(tokens(), "visit-1234", () => source);
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    await uploader.pull();
    expect(uploader.pending).toBe(1);
    await uploader.pull();
    expect(posts().map((p) => p.body.seq)).toEqual([0, 0, 1]);
    expect(uploader.pending).toBe(0);
    status = 413;
    await uploader.pull();
    expect(uploader.pending).toBe(0);
  });

  it("at page exit sends what waits, then the newest part as plain JSON, final, with keepalive", async () => {
    const source = game([chunk(0), chunk(1)]);
    const uploader = new TapeUploader(tokens(), "visit-1234", () => source);
    await tokens().get();
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    await uploader.pull();
    uploader.pullOnExit();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const exit = posts().slice(1);
    expect(exit.map((p) => [p.body.seq, p.body.enc, p.init.keepalive, p.body.final ?? false])).toEqual([
      [0, "gzip-b64", true, false],
      [1, "json", true, true],
    ]);
    expect(JSON.parse(exit[1].body.data)).toEqual(chunk(1));
  });

  it("keeps page-exit uploads inside the keepalive budget", async () => {
    const big = chunk(0, { kv: [[0, "save.0", "y".repeat(KEEPALIVE_MAX_BYTES)]] });
    const uploader = new TapeUploader(tokens(), "visit-1234", () => game([big]));
    uploader.pullOnExit();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("marks the last chunk of a stopped tape final and takes nothing after it", async () => {
    const source = game([chunk(0, { end: "demo" }), chunk(1)]);
    const uploader = new TapeUploader(tokens(), "visit-1234", () => source);
    await uploader.pull();
    await uploader.pull();
    expect(posts().map((p) => [p.body.seq, p.body.final])).toEqual([[0, true]]);
    expect(source.taken).toBe(1);
  });
});

describe("TapeUploader page exit, measured", () => {
  it("counts the quoting of a plain JSON chunk against the keepalive budget", async () => {
    // about 54,000 characters of data, but every quote doubles inside the request: over 60 kB once sent
    const quoted = chunk(0, { ev: Array.from({ length: 2_600 }, (_, index) => [index, "map", "a", "b"]) });
    expect(JSON.stringify(quoted).length).toBeLessThan(KEEPALIVE_MAX_BYTES);
    const uploader = new TapeUploader(new TokenCache(async () => "token-1"), "visit-1234", () => game([quoted]));
    uploader.pullOnExit();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
