import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COMMAND_SEARCH_RECENT_KEY, clearCommandSearchRecent, isDossierPulseId, readCommandSearchRecent, readCommandSearchRecentEntries,
  recordCommandSearchRecent, recordCommandSearchRecentOpponent, type CommandRecentStorage,
} from "../commandSearchRecent";

const allowed = ["today", "opponents", "trends", "builds", "sessions", "settings", "devices", "help", "community"];

function memoryStorage(initial: string | null = null) {
  let raw = initial;
  return {
    getItem: vi.fn((key: string) => key === COMMAND_SEARCH_RECENT_KEY ? raw : null),
    setItem: vi.fn((key: string, value: string) => { if (key === COMMAND_SEARCH_RECENT_KEY) raw = value; }),
    removeItem: vi.fn((key: string) => { if (key === COMMAND_SEARCH_RECENT_KEY) raw = null; }),
    raw: () => raw,
  };
}

function envelope(viewer: string, ids: unknown) {
  return JSON.stringify({ version: 1, viewer, ids });
}
const pages = (...ids: string[]) => ids.map(id => ({ kind: "page", id }));
function envelope2(viewer: string, entries: unknown) {
  return JSON.stringify({ version: 2, viewer, entries });
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("static recent destination envelope", () => {
  it("hides keys a narrower page does not list, and keeps them when that page records a visit", () => {
    const storage = memoryStorage();
    recordCommandSearchRecent("viewer-a", "today", allowed, storage);
    recordCommandSearchRecent("viewer-a", "opponents", allowed, storage);
    // A marketing page lists only some destinations: reading there hides, never erases.
    expect(readCommandSearchRecent("viewer-a", ["community", "help"], storage)).toEqual([]);
    expect(readCommandSearchRecent("viewer-a", ["today", "help"], storage)).toEqual(["today"]);
    expect(JSON.parse(storage.raw()!).entries).toEqual(pages("opponents", "today"));
    expect(recordCommandSearchRecent("viewer-a", "help", ["community", "help"], storage)).toEqual(["help", "opponents", "today"]);
    expect(readCommandSearchRecent("viewer-a", allowed, storage)).toEqual(["help", "opponents", "today"]);
    expect(readCommandSearchRecent("viewer-b", allowed, storage)).toEqual([]);
  });
  it("writes only version/viewer/static entries at the exact key, and moves a repeat to the front", () => {
    const storage = memoryStorage();
    expect(recordCommandSearchRecent("viewer-a", "today", allowed, storage)).toEqual(["today"]);
    recordCommandSearchRecent("viewer-a", "opponents", allowed, storage);
    expect(recordCommandSearchRecent("viewer-a", "today", allowed, storage)).toEqual(["today", "opponents"]);
    expect(storage.setItem).toHaveBeenLastCalledWith(COMMAND_SEARCH_RECENT_KEY,
      JSON.stringify({ version: 2, viewer: "viewer-a", entries: pages("today", "opponents") }));
    expect(Object.keys(JSON.parse(storage.raw()!)).sort()).toEqual(["entries", "version", "viewer"]);
    expect(readCommandSearchRecent("viewer-a", allowed, storage)).toEqual(["today", "opponents"]);
  });

  it("keeps the latest eight distinct admitted IDs", () => {
    const storage = memoryStorage();
    for (const id of allowed) recordCommandSearchRecent("viewer-a", id, allowed, storage);
    expect(readCommandSearchRecent("viewer-a", allowed, storage)).toEqual([...allowed].reverse().slice(0, 8));
    expect(JSON.parse(storage.raw()!).entries).toHaveLength(8);
  });

  it("returns a fresh array without module-level owner or result cache", () => {
    const storage = memoryStorage(envelope("viewer-a", ["today"]));
    const first = readCommandSearchRecent("viewer-a", allowed, storage);
    first.push("devices");
    expect(readCommandSearchRecent("viewer-a", allowed, storage)).toEqual(["today"]);
    expect(readCommandSearchRecent("viewer-a", allowed, memoryStorage())).toEqual([]);
  });
});

describe("viewer lifetime and sign-out", () => {
  it("never reads, writes or removes storage for a signed-out viewer", () => {
    const storage = memoryStorage(envelope("viewer-a", ["today"]));
    expect(readCommandSearchRecent(null, allowed, storage)).toEqual([]);
    expect(recordCommandSearchRecent(null, "today", allowed, storage)).toEqual([]);
    expect(clearCommandSearchRecent(null, storage)).toBe(false);
    expect(storage.getItem).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  it("fails closed across A to B to A and does not merge another viewer's entries", () => {
    const storage = memoryStorage();
    recordCommandSearchRecent("viewer-a", "today", allowed, storage);
    expect(readCommandSearchRecent("viewer-b", allowed, storage)).toEqual([]);
    recordCommandSearchRecent("viewer-b", "devices", allowed, storage);
    expect(readCommandSearchRecent("viewer-a", allowed, storage)).toEqual([]);
    expect(recordCommandSearchRecent("viewer-a", "settings", allowed, storage)).toEqual(["settings"]);
    expect(readCommandSearchRecent("viewer-b", allowed, storage)).toEqual([]);
  });

  it("late sign-out A cannot remove B, while B can remove its own current envelope", () => {
    const storage = memoryStorage(envelope("viewer-b", ["devices"]));
    expect(clearCommandSearchRecent("viewer-a", storage)).toBe(false);
    expect(storage.removeItem).not.toHaveBeenCalled();
    expect(readCommandSearchRecent("viewer-b", allowed, storage)).toEqual(["devices"]);
    expect(clearCommandSearchRecent("viewer-b", storage)).toBe(true);
    expect(storage.removeItem).toHaveBeenCalledWith(COMMAND_SEARCH_RECENT_KEY);
    expect(storage.raw()).toBeNull();
  });

  it.each(["", "viewer name", "user_A?token=secret", "user_A\n", "a".repeat(257)])(
    "rejects invalid viewer identity %# without touching storage", viewer => {
      const storage = memoryStorage();
      expect(readCommandSearchRecent(viewer, allowed, storage)).toEqual([]);
      expect(recordCommandSearchRecent(viewer, "today", allowed, storage)).toEqual([]);
      expect(clearCommandSearchRecent(viewer, storage)).toBe(false);
      expect(storage.getItem).not.toHaveBeenCalled();
      expect(storage.setItem).not.toHaveBeenCalled();
      expect(storage.removeItem).not.toHaveBeenCalled();
    },
  );
});

describe("corrupt or unsafe stored history", () => {
  it.each([
    "{", "null", "[]", "true", JSON.stringify({ version: 2, viewer: "viewer-a", ids: ["today"] }),
    JSON.stringify({ version: 1, viewer: "viewer-a", ids: ["today"], query: "private" }),
    envelope("viewer-a", ["today", "today"]), envelope("viewer-a", ["not-admitted"]),
    envelope("viewer-a", ["/app?token=private"]), envelope("viewer-a", ["navigation:today"]),
    envelope("viewer-a", ["today\n"]), envelope("viewer-a", [12]), envelope("viewer-a", allowed),
    envelope("viewer-a", ["today"]) + " ".repeat(2_049),
  ])("rejects corrupt payload %# rather than exposing a partial history", raw => {
    const storage = memoryStorage(raw);
    expect(readCommandSearchRecent("viewer-a", allowed, storage)).toEqual([]);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it.each(["/app", "https://foreign.test", "today?search=private", "navigation:today", "today\n", "TOKEN_VALUE"])(
    "does not persist unsafe destination %s even if a caller includes it", id => {
      const storage = memoryStorage();
      expect(recordCommandSearchRecent("viewer-a", id, [...allowed, id], storage)).toEqual([]);
      expect(storage.getItem).not.toHaveBeenCalled();
      expect(storage.setItem).not.toHaveBeenCalled();
    },
  );

  it("rejects unknown IDs and an oversized caller allowlist without storage mutation", () => {
    const storage = memoryStorage();
    expect(recordCommandSearchRecent("viewer-a", "admin", allowed, storage)).toEqual([]);
    const tooMany = Array.from({ length: 129 }, (_, index) => `destination-${index}`);
    expect(recordCommandSearchRecent("viewer-a", "destination-0", tooMany, storage)).toEqual([]);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("replaces corrupt input with a fresh admitted visit, without retaining unsafe fields", () => {
    const storage = memoryStorage(JSON.stringify({ version: 1, viewer: "viewer-a", ids: ["/app"], token: "secret" }));
    expect(recordCommandSearchRecent("viewer-a", "today", allowed, storage)).toEqual(["today"]);
    expect(storage.raw()).toBe(envelope2("viewer-a", pages("today")));
  });
});

describe("opponent dossiers in Recent (version 2)", () => {
  it("records a dossier by its toon-handle pulse ID only, newest first beside pages", () => {
    const storage = memoryStorage();
    recordCommandSearchRecent("viewer-a", "today", allowed, storage);
    expect(recordCommandSearchRecentOpponent("viewer-a", "1-S2-1-267727", allowed, storage)).toBe(true);
    expect(readCommandSearchRecentEntries("viewer-a", allowed, storage)).toEqual([
      { kind: "opponent", pulseId: "1-S2-1-267727" }, { kind: "page", id: "today" }]);
    expect(readCommandSearchRecent("viewer-a", allowed, storage)).toEqual(["today"]);
    expect(storage.raw()).toBe(envelope2("viewer-a", [{ kind: "opponent", pulseId: "1-S2-1-267727" }, ...pages("today")]));
  });
  it.each(["Rival", "1-S2-1-private", "1-S2-1-1/../settings", "1-S2-1-1\n", `1-S2-1-${"9".repeat(60)}`, "<b>1-S2-1-1</b>"])(
    "stores nothing for a dossier ID that is not a toon handle %#", pulseId => {
      const storage = memoryStorage();
      expect(recordCommandSearchRecentOpponent("viewer-a", pulseId, allowed, storage)).toBe(false);
      expect(storage.setItem).not.toHaveBeenCalled();
      expect(isDossierPulseId(pulseId)).toBe(false);
    });
  it("records and shows dossiers only where the navigation lists Opponents, keeping them stored elsewhere", () => {
    const storage = memoryStorage();
    expect(recordCommandSearchRecentOpponent("viewer-a", "2-S2-1-5", ["today", "help"], storage)).toBe(false);
    recordCommandSearchRecentOpponent("viewer-a", "2-S2-1-5", allowed, storage);
    expect(readCommandSearchRecentEntries("viewer-a", ["today", "help"], storage)).toEqual([]);
    recordCommandSearchRecent("viewer-a", "help", ["today", "help"], storage);
    expect(readCommandSearchRecentEntries("viewer-a", allowed, storage)).toEqual([
      { kind: "page", id: "help" }, { kind: "opponent", pulseId: "2-S2-1-5" }]);
  });
  it("moves a repeat to the front and keeps eight entries across both kinds", () => {
    const storage = memoryStorage();
    for (let index = 0; index < 6; index += 1) recordCommandSearchRecentOpponent("viewer-a", `1-S2-1-${index}`, allowed, storage);
    for (const id of ["today", "trends", "builds"]) recordCommandSearchRecent("viewer-a", id, allowed, storage);
    recordCommandSearchRecentOpponent("viewer-a", "1-S2-1-3", allowed, storage);
    expect(readCommandSearchRecentEntries("viewer-a", allowed, storage).map(entry => entry.kind === "page" ? entry.id : entry.pulseId))
      .toEqual(["1-S2-1-3", "builds", "trends", "today", "1-S2-1-5", "1-S2-1-4", "1-S2-1-2", "1-S2-1-1"]);
  });
  it("still reads a version-1 envelope and upgrades it on the next visit", () => {
    const storage = memoryStorage(envelope("viewer-a", ["today", "trends"]));
    expect(readCommandSearchRecentEntries("viewer-a", allowed, storage)).toEqual(pages("today", "trends"));
    expect(storage.setItem).not.toHaveBeenCalled();
    recordCommandSearchRecentOpponent("viewer-a", "1-S2-1-9", allowed, storage);
    expect(JSON.parse(storage.raw()!)).toEqual({ version: 2, viewer: "viewer-a",
      entries: [{ kind: "opponent", pulseId: "1-S2-1-9" }, ...pages("today", "trends")] });
  });
  it("clears either version on sign-out", () => {
    for (const raw of [envelope("viewer-a", ["today"]), envelope2("viewer-a", [{ kind: "opponent", pulseId: "1-S2-1-9" }])]) {
      const storage = memoryStorage(raw);
      expect(clearCommandSearchRecent("viewer-a", storage)).toBe(true);
      expect(storage.raw()).toBeNull();
    }
  });
  it.each([
    envelope2("viewer-a", [{ kind: "opponent", pulseId: "Rival" }]),
    envelope2("viewer-a", [{ kind: "opponent", pulseId: "1-S2-1-9", name: "Rival" }]),
    envelope2("viewer-a", [{ kind: "page", id: "today" }, { kind: "page", id: "today" }]),
    envelope2("viewer-a", [{ kind: "opponent", pulseId: "1-S2-1-9" }, { kind: "opponent", pulseId: "1-S2-1-9" }]),
    envelope2("viewer-a", [{ kind: "query", text: "Rival" }]),
    envelope2("viewer-a", pages(...Array.from({ length: 9 }, (_, index) => `page-${index}`))),
    JSON.stringify({ version: 2, viewer: "viewer-a", entries: pages("today"), ids: ["today"] }),
    JSON.stringify({ version: 3, viewer: "viewer-a", entries: pages("today") }),
  ])("rejects a version-2 envelope with any bad, repeated or extra part %#", raw => {
    expect(readCommandSearchRecentEntries("viewer-a", allowed, memoryStorage(raw))).toEqual([]);
  });
});

describe("unavailable or failing browser storage", () => {
  it("contains a denied localStorage accessor, and signed-out calls do not touch it", () => {
    const getter = vi.fn(() => { throw new Error("Storage is blocked"); });
    vi.stubGlobal("window", Object.defineProperty({}, "localStorage", { get: getter }));
    expect(readCommandSearchRecent(null, allowed)).toEqual([]);
    expect(getter).not.toHaveBeenCalled();
    expect(readCommandSearchRecent("viewer-a", allowed)).toEqual([]);
    expect(recordCommandSearchRecent("viewer-a", "today", allowed)).toEqual([]);
    expect(clearCommandSearchRecent("viewer-a")).toBe(false);
  });

  it("is safe without a browser", () => {
    vi.stubGlobal("window", undefined);
    expect(readCommandSearchRecent("viewer-a", allowed)).toEqual([]);
    expect(recordCommandSearchRecent("viewer-a", "today", allowed)).toEqual([]);
    expect(clearCommandSearchRecent("viewer-a")).toBe(false);
  });

  it("does not write after a failed read", () => {
    const storage = memoryStorage();
    storage.getItem.mockImplementation(() => { throw new Error("Read denied"); });
    expect(readCommandSearchRecent("viewer-a", allowed, storage)).toEqual([]);
    expect(recordCommandSearchRecent("viewer-a", "today", allowed, storage)).toEqual([]);
    expect(clearCommandSearchRecent("viewer-a", storage)).toBe(false);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  it("contains failed writes and removes without claiming persistence or successful clear", () => {
    const storage: CommandRecentStorage = {
      getItem: () => envelope("viewer-a", ["today"]),
      setItem: () => { throw new Error("Quota exceeded"); },
      removeItem: () => { throw new Error("Remove denied"); },
    };
    expect(recordCommandSearchRecent("viewer-a", "devices", allowed, storage)).toEqual([]);
    expect(clearCommandSearchRecent("viewer-a", storage)).toBe(false);
  });
});
