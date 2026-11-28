import { afterEach, describe, expect, it, vi } from "vitest";
import { leagueName, loadProBoard, readProBoard } from "../proBoard";

const player = (extra: Record<string, unknown> = {}) => ({ race: "zerg", league: "grandmaster", rating: 5000, playedAt: "2026-11-28T08:50:00.000Z", ...extra });
const game = (extra: Record<string, unknown> = {}) => ({ map: "Blackrock", opponentRace: "terran", won: true, durationSec: 640, playedAt: "2026-11-28T08:30:00.000Z", ...extra });
const pro = (extra: Record<string, unknown> = {}) => ({
  ...player({ rating: 5034 }),
  nickname: "Reynor",
  team: "TeamX",
  live: { platform: "twitch", channel: "reynor", url: "https://www.twitch.tv/reynor", viewers: 120 },
  games: [game()],
  ...extra,
});
const board = (extra: Record<string, unknown> = {}) =>
  ({ available: true, showNames: true, pros: [pro()], players: [player()], fetchedAt: "2026-11-28T08:55:00.000Z", ...extra });

describe("readProBoard", () => {
  it("reads a board and the gate-off answer", () => {
    expect(readProBoard({ available: false })).toEqual({ available: false });
    expect(readProBoard(board())).toEqual({
      available: true,
      showNames: true,
      pros: [pro()],
      players: [player()],
      fetchedAt: "2026-11-28T08:55:00.000Z",
    });
  });

  it("drops rows it cannot read and keeps the rest", () => {
    const read = readProBoard(board({
      pros: [pro({ nickname: "" }), pro({ rating: "high" }), pro({ games: [game({ won: "yes" }), game({ opponentRace: "alien" }), 3] })],
      players: [player({ race: "elf" }), player({ playedAt: "later" }), null, player()],
    }));
    expect(read).toMatchObject({ available: true });
    expect(read && read.available && read.players).toEqual([player()]);
    expect(read && read.available && read.pros).toHaveLength(1);
    expect(read && read.available && read.pros[0].games).toEqual([game({ opponentRace: null })]);
  });

  it("shows no names unless the server says so, and rejects shapes it does not know", () => {
    expect(readProBoard(board({ showNames: undefined }))).toMatchObject({ showNames: false });
    expect(readProBoard(null)).toBeNull();
    expect(readProBoard({ available: "maybe" })).toBeNull();
    expect(readProBoard(board({ players: "none" }))).toBeNull();
    expect(readProBoard(board({ fetchedAt: "soon" }))).toBeNull();
  });

  it("keeps a live link only on the platform it names", () => {
    const live = (extra: Record<string, unknown>) => {
      const read = readProBoard(board({ pros: [pro({ live: { platform: "twitch", channel: "reynor", url: "https://www.twitch.tv/reynor", viewers: 1, ...extra } })] }));
      return read && read.available ? read.pros[0].live : "unread";
    };
    expect(live({})).toMatchObject({ channel: "reynor", url: "https://www.twitch.tv/reynor" });
    expect(live({ platform: "kick", url: "https://kick.com/reynor" })).toMatchObject({ platform: "kick" });
    expect(live({ url: "https://evil.example/reynor" })).toBeNull();
    expect(live({ url: "http://www.twitch.tv/reynor" })).toBeNull();
    expect(live({ platform: "kick" })).toBeNull();
    expect(live({ channel: "not a login" })).toBeNull();
    expect(live({ url: "not a url" })).toBeNull();
    expect(live({ platform: "mixer" })).toBeNull();
    expect(live({ viewers: -1 })).toBeNull();
  });
});

describe("loadProBoard", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("asks without credentials and returns the board", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => board() });
    vi.stubGlobal("fetch", fetchMock);
    expect(await loadProBoard()).toMatchObject({ available: true });
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/v1\/pros-on-ladder$/);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ credentials: "omit" });
  });

  it("fails on an error status or an unreadable body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));
    await expect(loadProBoard()).rejects.toThrow("unavailable");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ nope: 1 }) }));
    await expect(loadProBoard()).rejects.toThrow("could not be read");
  });

  it("is cancelled by the caller", async () => {
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    })));
    const caller = new AbortController();
    const pending = loadProBoard(caller.signal);
    caller.abort();
    await expect(pending).rejects.toThrow("aborted");
  });
});

describe("leagueName", () => {
  it("capitalises the league", () => {
    expect(leagueName("grandmaster")).toBe("Grandmaster");
  });
});
