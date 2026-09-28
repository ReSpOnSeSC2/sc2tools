/**
 * runBrowserUpload — upload → save confirmed toons → optional backup,
 * driven with MOCK services (no network): `uploadGames`,
 * `saveConfirmedToons`, `backupReplays` and `apiCall` are all fakes, and
 * GA4 `gaEvent` is mocked.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { backupItemsFor, runBrowserUpload, uploadCounts, type BrowserUploadInput, type ImportRunnerServices } from "../importRunner";
import type { ApiCallFn } from "../profileHandles";
import type { BackupDeps, BackupItem, BackupSummary } from "../replayBackup";
import type { ParsedWithFile } from "../sessionState";
import type { IntakeFile, ParsedGame, UploadableGame } from "../types";
import type { UploadDeps, UploadSummary } from "../uploader";

const { gaEvent } = vi.hoisted(() => ({ gaEvent: vi.fn() }));
vi.mock("@/lib/analytics/gtag", () => ({ gaEvent }));
// MOCK: the real apiCall needs Clerk; every test injects its own services.
vi.mock("@/lib/clientApi", () => ({ apiCall: vi.fn() }));

const DIGESTS = { sha256: "ab".repeat(32), md5: "bWQ1", sizeBytes: 3 };

function intake(name: string): IntakeFile {
  const blob = new Blob([new Uint8Array([1, 2, 3])]);
  return { key: name, name, relativePath: name, size: 3, lastModified: 1, source: "picker", blob };
}

function parsed(gameId: string, withDigests = true): ParsedWithFile {
  const game: ParsedGame = {
    ok: true,
    fileName: `${gameId}.SC2Replay`,
    relativePath: `${gameId}.SC2Replay`,
    gameId,
    json: `{"gameId":"${gameId}"}`,
    date: "2026-09-01T00:00:00Z",
    myToonHandle: "1-S2-1-111",
    matchFormat: "1v1",
    isResumedFromReplay: false,
    ms: 10,
  };
  if (withDigests) game.digests = DIGESTS;
  return { game, file: intake(`${gameId}.SC2Replay`) };
}

function uploadSummary(overrides: Partial<UploadSummary> = {}): UploadSummary {
  return { accepted: [], rejected: [], skippedExisting: [], oversized: [], pending: [], ...overrides };
}

const BACKUP_DONE: BackupSummary = { backedUp: ["g1"], alreadyStored: [], skipped: [], failed: [] };

/** MOCK services that record the order they were called in. */
function mockServices(upload: UploadSummary) {
  const calls: string[] = [];
  const services = {
    uploadGames: vi.fn(async (_games: ReadonlyArray<UploadableGame>, _deps: UploadDeps) => {
      calls.push("upload");
      return upload;
    }),
    saveConfirmedToons: vi.fn(async (_getToken: () => Promise<string | null>, _toons: ReadonlyArray<string>, _api: ApiCallFn) => {
      calls.push("toons");
      return { changed: true, pulseIds: ["1-S2-1-111"] };
    }),
    backupReplays: vi.fn(async (_items: ReadonlyArray<BackupItem>, _deps: BackupDeps) => {
      calls.push("backup");
      return BACKUP_DONE;
    }),
    apiCall: vi.fn(),
  } satisfies ImportRunnerServices;
  return { calls, services };
}

function input(services: Partial<ImportRunnerServices>, overrides: Partial<BrowserUploadInput> = {}): BrowserUploadInput {
  return {
    parsedWithFiles: [parsed("g1"), parsed("g2", false), parsed("g3")],
    getToken: async () => "token",
    apiBase: "https://api.test",
    engineVersion: "1.6.3",
    backup: { enabled: true, capabilityEnabled: true },
    confirmedToons: ["1-S2-1-111"],
    services,
    ...overrides,
  };
}

afterEach(() => {
  gaEvent.mockReset();
});

describe("runBrowserUpload", () => {
  it("uploads, then saves the confirmed toon, then backs up accepted games with digests", async () => {
    const marker = { available: true, sizeBytes: 3, sha256: DIGESTS.sha256 };
    const upload = uploadSummary({
      accepted: [
        { gameId: "g1", created: true, replayArchive: marker },
        { gameId: "g2", created: false },
      ],
      skippedExisting: ["g3"],
    });
    const { calls, services } = mockServices(upload);
    const summary = await runBrowserUpload(input(services));

    expect(calls).toEqual(["upload", "toons", "backup"]);
    const [games, deps] = services.uploadGames.mock.calls[0] ?? [];
    expect(games?.map((game) => game.gameId)).toEqual(["g1", "g2", "g3"]);
    expect(deps).toMatchObject({ apiBase: "https://api.test", engineVersion: "1.6.3" });
    expect(services.saveConfirmedToons).toHaveBeenCalledWith(expect.any(Function), ["1-S2-1-111"], services.apiCall);
    // g2 has no digests and g3 was already stored: only g1 is backed up, marker passed through.
    const items = services.backupReplays.mock.calls[0]?.[0] ?? [];
    expect(items.map((item) => [item.gameId, item.replayArchive])).toEqual([["g1", marker]]);
    expect(summary).toMatchObject({
      uploaded: 2,
      created: 1,
      skippedExisting: 1,
      rejected: 0,
      toonsSaved: true,
      backup: BACKUP_DONE,
      backupSkipped: null,
    });
    expect(gaEvent).toHaveBeenCalledWith("instant_upload_done", { games: 2 });
  });

  it("skips the backup when the server has no replay store", async () => {
    const { services } = mockServices(uploadSummary({ accepted: [{ gameId: "g1", created: true }] }));
    const summary = await runBrowserUpload(input(services, { backup: { enabled: true, capabilityEnabled: false } }));
    expect(services.backupReplays).not.toHaveBeenCalled();
    expect(summary.backupSkipped).toBe("unavailable");
    expect(summary.backup).toBeNull();
  });

  it("skips the backup when the visitor turned it off", async () => {
    const { services } = mockServices(uploadSummary({ accepted: [{ gameId: "g1", created: true }] }));
    const summary = await runBrowserUpload(input(services, { backup: { enabled: false, capabilityEnabled: true } }));
    expect(services.backupReplays).not.toHaveBeenCalled();
    expect(summary.backupSkipped).toBe("disabled");
  });

});

describe("runBrowserUpload: early stops and best effort", () => {
  it("stops after an auth failure: no profile write, no backup, error tracked", async () => {
    const { calls, services } = mockServices(uploadSummary({ pending: ["g1", "g2", "g3"], stoppedReason: "auth" }));
    const summary = await runBrowserUpload(input(services));
    expect(calls).toEqual(["upload"]);
    expect(summary).toMatchObject({ stoppedReason: "auth", pending: 3, backupSkipped: "upload_stopped" });
    expect(gaEvent).toHaveBeenCalledWith("instant_error", { kind: "upload_auth" });
  });

  it("still saves the toon and backs up what fit before the daily cap", async () => {
    const upload = uploadSummary({ accepted: [{ gameId: "g1", created: true }], pending: ["g3"], stoppedReason: "daily_cap" });
    const { calls, services } = mockServices(upload);
    const summary = await runBrowserUpload(input(services));
    expect(calls).toEqual(["upload", "toons", "backup"]);
    expect(summary).toMatchObject({ uploaded: 1, pending: 1, stoppedReason: "daily_cap" });
    expect(gaEvent).toHaveBeenCalledWith("instant_error", { kind: "upload_daily_cap" });
  });

  it("does not report a cancelled upload as done", async () => {
    const { services } = mockServices(uploadSummary({ stoppedReason: "aborted", pending: ["g1"] }));
    const summary = await runBrowserUpload(input(services));
    expect(summary.stoppedReason).toBe("aborted");
    expect(gaEvent).not.toHaveBeenCalled();
    expect(services.backupReplays).not.toHaveBeenCalled();
  });

  it("treats a failing profile update as best effort", async () => {
    const { services } = mockServices(uploadSummary({ accepted: [{ gameId: "g1", created: true }] }));
    services.saveConfirmedToons.mockRejectedValueOnce(new Error("profile down"));
    const summary = await runBrowserUpload(input(services));
    expect(summary.toonsSaved).toBe(false);
    expect(services.backupReplays).toHaveBeenCalledTimes(1);
  });

  it("does not touch the profile when no player was confirmed", async () => {
    const { services } = mockServices(uploadSummary({ accepted: [{ gameId: "g1", created: true }] }));
    await runBrowserUpload(input(services, { confirmedToons: [] }));
    expect(services.saveConfirmedToons).not.toHaveBeenCalled();
  });

  it("reports progress for every stage", async () => {
    const { services } = mockServices(uploadSummary({ accepted: [{ gameId: "g1", created: true }] }));
    services.uploadGames.mockImplementationOnce(async (_games, deps) => {
      deps.onProgress?.({ phase: "uploading", accepted: 1, settled: 1, total: 3 });
      return uploadSummary({ accepted: [{ gameId: "g1", created: true }] });
    });
    const stages: string[] = [];
    await runBrowserUpload(input(services, { onProgress: (progress) => stages.push(progress.stage) }));
    expect(stages).toEqual(["uploading", "profile", "backup"]);
  });
});

describe("uploadCounts / backupItemsFor", () => {
  it("counts oversized games as rejected", () => {
    const counts = uploadCounts(uploadSummary({ rejected: [{ gameId: "a", errors: ["x"] }], oversized: ["b"] }));
    expect(counts.rejected).toBe(2);
    expect(counts.stoppedReason).toBeUndefined();
    expect(counts.dailyCapResetAt).toBeUndefined();
  });

  it("carries the daily cap's reset time", () => {
    const resetAt = Date.parse("2026-09-29T00:00:00Z");
    const counts = uploadCounts(uploadSummary({
      stoppedReason: "daily_cap", dailyCap: { limit: 5000, remaining: 0, resetAt },
    }));
    expect(counts).toMatchObject({ stoppedReason: "daily_cap", dailyCapResetAt: resetAt });
  });

  it("ignores accepted ids that were not part of this run", () => {
    expect(backupItemsFor([parsed("g1")], [{ gameId: "other", created: true }])).toEqual([]);
  });
});
