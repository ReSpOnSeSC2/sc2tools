import { describe, expect, it, vi } from "vitest";
import {
  archiveMatches,
  backupReplays,
  putHeaders,
  sanitizeReplayFilename,
  type BackupDeps,
  type BackupItem,
} from "../replayBackup";
import { makeIntakeFile } from "../fileIntake";

const API = "https://api.test";
const R2 = "https://r2.test/raw-replays-pending/u/g.SC2Replay?sig=1";
const SHA = "a".repeat(64);
const MD5 = "AAAAAAAAAAAAAAAAAAAAAA==";
const UPLOAD_ID = "upload_abcdefghijklmnopqrst";
const SIGNED_HEADERS = {
  "content-type": "application/octet-stream",
  "content-length": "8",
  "cache-control": "private, no-store",
  "content-md5": MD5,
  "x-amz-meta-sha256": SHA,
};

interface Call {
  method: string;
  url: string;
  headers: Headers;
  body: BodyInit | null | undefined;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function item(gameId = "2026-05-08T19:08:12|Opp|Map|470", bytes = 8, patch: Partial<BackupItem> = {}): BackupItem {
  const file = new File([new Uint8Array(bytes)], "Tourmaline LE.SC2Replay", { lastModified: 1 });
  return {
    gameId,
    file: makeIntakeFile(file, "folder", "1-S2-1-5/Replays/Multiplayer/Tourmaline LE.SC2Replay"),
    digests: { sha256: SHA, md5: MD5, sizeBytes: bytes },
    ...patch,
  };
}

/** Mock API + R2: `respond(call)` decides each reply. */
function mockNetwork(respond: (call: Call, n: number) => Response | Error) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = {
      method: init?.method ?? "GET",
      url: String(input),
      headers: new Headers(init?.headers),
      body: init?.body,
    };
    calls.push(call);
    const reply = respond(call, calls.length - 1);
    if (reply instanceof Error) throw reply;
    return reply;
  });
  return { fetchImpl, calls };
}

function happyPath(call: Call): Response {
  if (call.url.endsWith("/replay-upload")) {
    return json(200, { url: R2, headers: SIGNED_HEADERS, uploadId: UPLOAD_ID, expiresIn: 300 });
  }
  if (call.url === R2) return new Response(null, { status: 200 });
  return json(200, { ok: true, replayAvailable: true, replay: { sizeBytes: 8, sha256: SHA } });
}

function deps(fetchImpl: typeof fetch, extra: Partial<BackupDeps> = {}): BackupDeps {
  return {
    getToken: async () => "tok",
    apiBase: API,
    fetchImpl,
    sleep: vi.fn(async () => {}),
    random: () => 0.5,
    ...extra,
  };
}

describe("backupReplays", () => {
  it("prepares, PUTs without content-length, then completes", async () => {
    const net = mockNetwork(happyPath);
    const summary = await backupReplays([item()], deps(net.fetchImpl));
    expect(summary).toEqual({
      backedUp: ["2026-05-08T19:08:12|Opp|Map|470"],
      alreadyStored: [],
      skipped: [],
      failed: [],
    });
    const [prepare, put, complete] = net.calls;
    expect(prepare.url).toBe(`${API}/v1/games/2026-05-08T19%3A08%3A12%7COpp%7CMap%7C470/replay-upload`);
    expect(JSON.parse(String(prepare.body))).toEqual({
      filename: "Tourmaline LE.SC2Replay",
      sizeBytes: 8,
      sha256: SHA,
      md5: MD5,
    });
    expect(prepare.headers.get("authorization")).toBe("Bearer tok");
    expect(put.method).toBe("PUT");
    expect(put.headers.has("content-length")).toBe(false);
    expect(put.headers.get("content-md5")).toBe(MD5);
    expect(put.headers.get("x-amz-meta-sha256")).toBe(SHA);
    expect(put.headers.has("authorization")).toBe(false);
    expect(put.body).toBeInstanceOf(Blob);
    expect(complete.url).toMatch(/\/replay-upload\/complete$/);
    expect(JSON.parse(String(complete.body))).toEqual({ uploadId: UPLOAD_ID });
  });

  it("skips the upload when the archive marker already matches", async () => {
    const net = mockNetwork(happyPath);
    const marker = { available: true, sizeBytes: 8, sha256: SHA.toUpperCase() };
    const matched = item(undefined, 8, { replayArchive: marker });
    const summary = await backupReplays([matched], deps(net.fetchImpl));
    expect(summary.alreadyStored).toHaveLength(1);
    expect(net.calls).toHaveLength(0);
  });

  it("treats alreadyStored from prepare as done without a PUT", async () => {
    const net = mockNetwork(() => json(200, { alreadyStored: true, replayAvailable: true }));
    const summary = await backupReplays([item()], deps(net.fetchImpl));
    expect(summary.alreadyStored).toHaveLength(1);
    expect(net.calls).toHaveLength(1);
  });
});

describe("backupReplays: retries and skips", () => {
  it("retries 409 replay_upload_busy with backoff", async () => {
    const net = mockNetwork((call, n) =>
      n === 0 ? json(409, { error: { code: "replay_upload_busy" } }) : happyPath(call),
    );
    const d = deps(net.fetchImpl);
    const summary = await backupReplays([item()], d);
    expect(summary.backedUp).toHaveLength(1);
    expect(d.sleep).toHaveBeenCalledWith(1000, undefined);
  });

  it("skips on 400 without retrying, and on 404 game_not_found", async () => {
    const bad = mockNetwork(() => json(400, { error: { code: "invalid_replay_upload" } }));
    const d = deps(bad.fetchImpl);
    expect((await backupReplays([item()], d)).skipped).toHaveLength(1);
    expect(bad.calls).toHaveLength(1);
    expect(d.sleep).not.toHaveBeenCalled();
    const missing = mockNetwork(() => json(404, { error: { code: "game_not_found" } }));
    expect((await backupReplays([item()], deps(missing.fetchImpl))).skipped).toHaveLength(1);
  });

  it("skips files outside 4 B..5 MiB or changed since hashing", async () => {
    const net = mockNetwork(happyPath);
    const tiny = item("tiny", 2);
    const changed = item("changed", 8, { digests: { sha256: SHA, md5: MD5, sizeBytes: 9 } });
    const summary = await backupReplays([tiny, changed], deps(net.fetchImpl));
    expect(summary.skipped).toEqual(["tiny", "changed"]);
    expect(net.calls).toHaveLength(0);
  });
});

describe("backupReplays: failures", () => {
  it("fails after bounded retries on 503 and moves on", async () => {
    const net = mockNetwork((call) => (call.url.includes("first") ? json(503, {}) : happyPath(call)));
    const summary = await backupReplays([item("first"), item("second")], deps(net.fetchImpl, { maxAttempts: 3 }));
    expect(summary.failed).toEqual(["first"]);
    expect(summary.backedUp).toEqual(["second"]);
    expect(net.calls.filter((c) => c.url.includes("first"))).toHaveLength(3);
  });

  it("retries a failed PUT (network) and fails when complete is not confirmed", async () => {
    let putFailures = 0;
    const net = mockNetwork((call) => {
      if (call.url === R2 && putFailures === 0) {
        putFailures += 1;
        return new TypeError("Failed to fetch");
      }
      if (call.url.endsWith("/complete")) return json(200, { ok: true, replayAvailable: false });
      return happyPath(call);
    });
    const summary = await backupReplays([item()], deps(net.fetchImpl));
    expect(net.calls.filter((c) => c.url === R2)).toHaveLength(2);
    expect(summary.failed).toHaveLength(1);
  });
});

describe("backupReplays: stops", () => {
  it("stops the run on auth failure or abort", async () => {
    const denied = mockNetwork(() => json(403, { error: { code: "replay_upload_auth_required" } }));
    const summary = await backupReplays([item("a"), item("b")], deps(denied.fetchImpl));
    expect(summary.stoppedReason).toBe("auth");
    expect(denied.calls).toHaveLength(1);

    const controller = new AbortController();
    const net = mockNetwork((call) => {
      controller.abort();
      return happyPath(call);
    });
    const aborted = await backupReplays([item("a"), item("b")], deps(net.fetchImpl, { signal: controller.signal }));
    expect(aborted.stoppedReason).toBe("aborted");
  });

  it("stops the run when the server has no replay storage", async () => {
    const net = mockNetwork(() => json(503, { error: { code: "replay_storage_unavailable" } }));
    const d = deps(net.fetchImpl);
    const summary = await backupReplays([item("a"), item("b")], d);
    expect(summary.stoppedReason).toBe("unavailable");
    expect(net.calls).toHaveLength(1);
    expect(d.sleep).not.toHaveBeenCalled();
  });

  it("refreshes the token once, bypassing the cache, after a 401", async () => {
    const net = mockNetwork((call, n) => (n === 0 ? json(401, { error: { code: "invalid_token" } }) : happyPath(call)));
    const getToken = vi.fn(async (_options?: { skipCache?: boolean }) => "tok");
    const summary = await backupReplays([item()], deps(net.fetchImpl, { getToken }));
    expect(summary.backedUp).toHaveLength(1);
    expect(getToken.mock.calls.map((c) => c[0])).toEqual([undefined, { skipCache: true }, undefined]);
  });

  it("reports progress per item", async () => {
    const net = mockNetwork(happyPath);
    const onProgress = vi.fn();
    await backupReplays([item("a"), item("b")], deps(net.fetchImpl, { onProgress }));
    expect(onProgress.mock.calls.map((c) => c[0])).toEqual([
      { done: 1, total: 2 },
      { done: 2, total: 2 },
    ]);
  });
});

describe("helpers", () => {
  it("sanitises file names for the server", () => {
    expect(sanitizeReplayFilename("a/b\\Tourmaline LE.sc2replay")).toBe("Tourmaline LE.SC2Replay");
    expect(sanitizeReplayFilename("bad\u0001name\u007f.SC2Replay")).toBe("badname.SC2Replay");
    expect(sanitizeReplayFilename(".SC2Replay")).toBe("replay.SC2Replay");
    expect(sanitizeReplayFilename("x.zip")).toBe("x.zip.SC2Replay");
    const long = sanitizeReplayFilename(`${"n".repeat(400)}.SC2Replay`);
    expect(long).toHaveLength(255);
    expect(long.endsWith(".SC2Replay")).toBe(true);
  });

  it("keeps names with astral characters within the server's UTF-16 limit", () => {
    // Same checks as parseUploadRequest in apps/api/src/routes/replayFiles.js,
    // which measures `filename.length` in UTF-16 code units.
    const serverAccepts = (filename: string) =>
      filename.length <= 255 && !/[\\/\u0000-\u001f\u007f]/.test(filename) && /\.sc2replay$/i.test(filename);
    const emoji = sanitizeReplayFilename(`${"\u{1F642}".repeat(200)}.SC2Replay`);
    expect(serverAccepts(emoji)).toBe(true);
    expect(emoji).toBe(`${"\u{1F642}".repeat(122)}.SC2Replay`);
    // An odd budget never leaves half a surrogate pair behind.
    const mixed = sanitizeReplayFilename(`a${"\u{1F642}".repeat(200)}.SC2Replay`);
    expect(serverAccepts(mixed)).toBe(true);
    expect(mixed).toBe(`a${"\u{1F642}".repeat(122)}.SC2Replay`);
    expect(mixed.isWellFormed()).toBe(true);
  });

  it("drops content-length from signed headers (any case)", () => {
    expect(putHeaders({ "Content-Length": "8", "content-md5": MD5 })).toEqual({ "content-md5": MD5 });
  });

  it("matches archive markers on size and sha256 only when available", () => {
    const digests = { sha256: SHA, md5: MD5, sizeBytes: 8 };
    expect(archiveMatches({ available: true, sizeBytes: 8, sha256: SHA }, digests)).toBe(true);
    expect(archiveMatches({ available: false, sizeBytes: 8, sha256: SHA }, digests)).toBe(false);
    expect(archiveMatches({ available: true, sizeBytes: 9, sha256: SHA }, digests)).toBe(false);
    expect(archiveMatches({ available: true, sizeBytes: 8 }, digests)).toBe(false);
    expect(archiveMatches(undefined, digests)).toBe(false);
  });
});
