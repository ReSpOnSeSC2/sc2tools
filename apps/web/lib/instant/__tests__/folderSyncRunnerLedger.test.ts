/**
 * runFolderSync across passes — the retry cap for transient failures,
 * re-checking unidentified players once the profile knows them, a
 * browser that refuses storage, and Folder Sync state owned by another
 * account. MOCK engine, MOCK upload and in-memory MOCK store (see
 * fixtures/folderSyncMocks.ts).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { runFolderSync, type FolderSyncStore } from "../folderSyncRunner";
import { InstantDbUnavailableError } from "../idb";
import { MAX_RETRYABLE_ATTEMPTS } from "../ledger";
import { ME, NOW, memoryStore, replay, setup } from "./fixtures/folderSyncMocks";

const { gaEvent } = vi.hoisted(() => ({ gaEvent: vi.fn() }));
vi.mock("@/lib/analytics/gtag", () => ({ gaEvent }));

const OWNER = "user_owner";

afterEach(() => {
  gaEvent.mockReset();
});

describe("runFolderSync: transient failures", () => {
  it("settles a file after its third timeout, so a fourth pass never starts the engine", async () => {
    const files = [replay("slow.SC2Replay")];
    const memory = memoryStore();
    for (let pass = 1; pass <= MAX_RETRYABLE_ATTEMPTS; pass += 1) {
      const { engine, engineFactory, input } = setup(files, [], { store: memory.store });
      engine.failParse.add("slow.SC2Replay");
      await runFolderSync(input);
      expect(engineFactory).toHaveBeenCalledTimes(1);
      expect(memory.ledger.get(files[0].relativePath)).toMatchObject({ status: "failed", errorKind: "timeout", attempts: pass });
    }

    const fourth = setup(files, [], { store: memory.store });
    const summary = await runFolderSync(fourth.input);

    expect(fourth.engineFactory).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ newFiles: 0, engineStarted: false });
  });

  it("restarts the count when the file changed", async () => {
    const memory = memoryStore();
    const first = setup([replay("slow.SC2Replay")], [], { store: memory.store });
    first.engine.failParse.add("slow.SC2Replay");
    await runFolderSync(first.input);

    const changed = replay("slow.SC2Replay", undefined, NOW - 10);
    const second = setup([changed], [], { store: memory.store });
    second.engine.failParse.add("slow.SC2Replay");
    await runFolderSync(second.input);

    expect(memory.ledger.get(changed.relativePath)).toMatchObject({ attempts: 1, lastModified: NOW - 10 });
  });
});

describe("runFolderSync: unidentified players", () => {
  it("re-checks a loose replay only once the profile knows one of its toons", async () => {
    const files = [replay("loose.SC2Replay", "Multiplayer")];
    const memory = memoryStore();
    const first = setup(files, [], { store: memory.store, profileToons: [] });
    await runFolderSync(first.input);
    expect(memory.ledger.get(files[0].relativePath)).toMatchObject({
      status: "failed", errorKind: "player_unresolved", toons: [ME, "2-S2-1-15"],
    });

    const unrelated = vi.fn(async () => ["9-S2-1-999"]);
    const second = setup(files, [], { store: memory.store, profileToons: unrelated });
    await runFolderSync(second.input);
    expect(unrelated).toHaveBeenCalledTimes(1);
    expect(second.engineFactory).not.toHaveBeenCalled();

    const third = setup(files, [], { store: memory.store, profileToons: async () => [ME] });
    await runFolderSync(third.input);
    expect(third.uploads).toEqual([["g-loose.SC2Replay"]]);
    expect(memory.ledger.get(files[0].relativePath)).toMatchObject({ status: "uploaded" });
  });

  it("never re-checks a replay whose toon folder names someone who did not play", async () => {
    const files = [replay("x.SC2Replay", "Accounts/9/3-S2-1-333/Replays/Multiplayer")];
    const memory = memoryStore();
    await runFolderSync(setup(files, [], { store: memory.store }).input);
    const entry = memory.ledger.get(files[0].relativePath);
    expect(entry).toMatchObject({ errorKind: "player_unresolved" });
    expect(entry?.toons).toBeUndefined();

    const loader = vi.fn(async () => [ME]);
    const again = setup(files, [], { store: memory.store, profileToons: loader });
    await runFolderSync(again.input);
    expect(loader).not.toHaveBeenCalled();
    expect(again.engineFactory).not.toHaveBeenCalled();
  });
});

describe("runFolderSync: storage refused", () => {
  it("still parses and uploads new files when IndexedDB is unavailable", async () => {
    const refused = (): Promise<never> => Promise.reject(new InstantDbUnavailableError("unsupported", "blocked"));
    const store: FolderSyncStore = {
      loadLedger: refused,
      saveLedgerEntries: refused,
      setLastFolderScanAt: refused,
      getFolderOwner: refused,
    };
    const { uploads, input } = setup([replay("a.SC2Replay")], [], { store, ownerUserId: OWNER });

    const summary = await runFolderSync(input);

    expect(uploads).toEqual([["g-a.SC2Replay"]]);
    expect(summary).toMatchObject({ uploaded: 1, aborted: false });
    expect(summary.notOwner).toBeUndefined();
  });

  it("still rejects on other storage errors", async () => {
    const store: FolderSyncStore = {
      loadLedger: () => Promise.reject(new Error("disk on fire")),
      saveLedgerEntries: async () => undefined,
      setLastFolderScanAt: async () => undefined,
    };
    const { input } = setup([replay("a.SC2Replay")], [], { store });
    await expect(runFolderSync(input)).rejects.toThrow("disk on fire");
  });
});

describe("runFolderSync: account binding", () => {
  function ownedStore(owner: string | null) {
    const memory = memoryStore();
    const store: FolderSyncStore = { ...memory.store, getFolderOwner: async () => owner };
    return { ...memory, store };
  }

  it("does nothing when the stored Folder Sync state belongs to another account", async () => {
    const walk = vi.fn(async () => [replay("a.SC2Replay")]);
    const handle = { kind: "directory" as const, name: "StarCraft II", values: () => ({ async *[Symbol.asyncIterator]() {} }) };
    for (const owner of ["user_other", null]) {
      const memory = ownedStore(owner);
      const { engineFactory, uploadGames, input } = setup([], [], { source: { handle }, store: memory.store, ownerUserId: OWNER });
      input.services = { ...input.services, walk };

      const summary = await runFolderSync(input);

      expect(summary.notOwner).toBe(true);
      expect(walk).not.toHaveBeenCalled();
      expect(engineFactory).not.toHaveBeenCalled();
      expect(uploadGames).not.toHaveBeenCalled();
      expect(memory.lastScan()).toBeNull();
    }
  });

  it("syncs when the signed-in account owns the stored state", async () => {
    const memory = ownedStore(OWNER);
    const { uploads, input } = setup([replay("a.SC2Replay")], [], { store: memory.store, ownerUserId: OWNER });
    const summary = await runFolderSync(input);
    expect(summary.notOwner).toBeUndefined();
    expect(uploads).toEqual([["g-a.SC2Replay"]]);
  });
});
