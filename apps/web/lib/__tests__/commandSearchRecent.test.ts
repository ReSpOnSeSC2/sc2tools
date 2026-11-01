import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COMMAND_SEARCH_RECENT_KEY, clearCommandSearchRecent, readCommandSearchRecent, recordCommandSearchRecent,
  type CommandRecentStorage,
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

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("static recent destination envelope", () => {
  it("hides keys a narrower page does not list, and keeps them when that page records a visit", () => {
    const storage = memoryStorage();
    recordCommandSearchRecent("viewer-a", "today", allowed, storage);
    recordCommandSearchRecent("viewer-a", "opponents", allowed, storage);
    // A marketing page lists only some destinations: reading there hides, never erases.
    expect(readCommandSearchRecent("viewer-a", ["community", "help"], storage)).toEqual([]);
    expect(JSON.parse(storage.raw()!).ids).toEqual(["opponents", "today"]);
    expect(recordCommandSearchRecent("viewer-a", "help", ["community", "help"], storage)).toEqual(["help", "opponents", "today"]);
    expect(readCommandSearchRecent("viewer-a", allowed, storage)).toEqual(["help", "opponents", "today"]);
    expect(readCommandSearchRecent("viewer-b", allowed, storage)).toEqual([]);
  });
  it("writes only version/viewer/static IDs at the exact key, and moves a repeat to the front", () => {
    const storage = memoryStorage();
    expect(recordCommandSearchRecent("viewer-a", "today", allowed, storage)).toEqual(["today"]);
    recordCommandSearchRecent("viewer-a", "opponents", allowed, storage);
    expect(recordCommandSearchRecent("viewer-a", "today", allowed, storage)).toEqual(["today", "opponents"]);
    expect(storage.setItem).toHaveBeenLastCalledWith(COMMAND_SEARCH_RECENT_KEY,
      JSON.stringify({ version: 1, viewer: "viewer-a", ids: ["today", "opponents"] }));
    expect(Object.keys(JSON.parse(storage.raw()!)).sort()).toEqual(["ids", "version", "viewer"]);
    expect(readCommandSearchRecent("viewer-a", allowed, storage)).toEqual(["today", "opponents"]);
  });

  it("keeps the latest eight distinct admitted IDs", () => {
    const storage = memoryStorage();
    for (const id of allowed) recordCommandSearchRecent("viewer-a", id, allowed, storage);
    expect(readCommandSearchRecent("viewer-a", allowed, storage)).toEqual([...allowed].reverse().slice(0, 8));
    expect(JSON.parse(storage.raw()!).ids).toHaveLength(8);
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
    expect(storage.raw()).toBe(envelope("viewer-a", ["today"]));
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
