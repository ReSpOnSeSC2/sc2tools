import { describe, expect, test } from "vitest";
import {
  groupMatchesSearch,
  groupOpponentsByPlayer,
  type GroupableOpponent,
  type PulseLink,
} from "../opponentGroups";

type Row = GroupableOpponent & { toonHandle?: string | null };

function row(partial: Partial<Row> & { pulseId: string }): Row {
  return {
    pulseCharacterId: null,
    name: "",
    revealedName: null,
    wins: 0,
    losses: 0,
    games: 0,
    winRate: 0,
    mmr: null,
    lastPlayed: null,
    ...partial,
  };
}

function link(partial: Partial<PulseLink> = {}): PulseLink {
  return { accountId: null, proId: null, proNickname: null, ...partial };
}

describe("groupOpponentsByPlayer", () => {
  test("no links → every row is its own singleton group", () => {
    const rows = [
      row({ pulseId: "a", name: "Alpha", games: 3 }),
      row({ pulseId: "b", name: "Beta", games: 1 }),
    ];
    const groups = groupOpponentsByPlayer(rows, null);
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.groupSize === 1)).toBe(true);
    expect(groups[0].aliasNames).toEqual([]);
  });

  test("rows sharing an accountId merge into one group with summed stats", () => {
    const rows = [
      row({
        pulseId: "a",
        pulseCharacterId: "1",
        name: "OldName",
        wins: 6,
        losses: 4,
        games: 10,
        winRate: 0.6,
        mmr: 4000,
        netMmr: 24,
        mmrWon: 44,
        mmrLost: 20,
        mmrPairs: 3,
        lastPlayed: "2026-01-01T00:00:00Z",
      }),
      row({
        pulseId: "b",
        pulseCharacterId: "2",
        name: "NewName",
        wins: 1,
        losses: 1,
        games: 2,
        winRate: 0.5,
        mmr: 4100,
        netMmr: -7,
        mmrWon: 11,
        mmrLost: 18,
        mmrPairs: 2,
        lastPlayed: "2026-06-01T00:00:00Z",
      }),
    ];
    const links = { 1: link({ accountId: "acc" }), 2: link({ accountId: "acc" }) };
    const groups = groupOpponentsByPlayer(rows, links);
    expect(groups).toHaveLength(1);
    const g = groups[0];
    expect(g.groupSize).toBe(2);
    expect(g.wins).toBe(7);
    expect(g.losses).toBe(5);
    expect(g.games).toBe(12);
    expect(g.winRate).toBeCloseTo(7 / 12);
    // Primary identity = most recently played → its ids drive the row.
    expect(g.pulseId).toBe("b");
    expect(g.pulseCharacterId).toBe("2");
    expect(g.lastPlayed).toBe("2026-06-01T00:00:00Z");
    // Freshest mmr wins (identity "b" is newest and carries one).
    expect(g.mmr).toBe(4100);
    expect(g.netMmr).toBe(17);
    expect(g.mmrWon).toBe(55);
    expect(g.mmrLost).toBe(38);
    expect(g.mmrPairs).toBe(5);
    expect(g.mmrAvgDelta).toBeCloseTo(17 / 5);
    // Most-played readable name is the main name; the other is an alias.
    expect(g.name).toBe("OldName");
    expect(g.aliasNames).toEqual(["NewName"]);
  });

  test("proId links across different accounts", () => {
    const rows = [
      row({ pulseId: "a", pulseCharacterId: "1", name: "Smurf", games: 1 }),
      row({ pulseId: "b", pulseCharacterId: "2", name: "MainAcct", games: 2 }),
    ];
    const links = {
      1: link({ accountId: "acc1", proId: "p9" }),
      2: link({ accountId: "acc2", proId: "p9" }),
    };
    expect(groupOpponentsByPlayer(rows, links)).toHaveLength(1);
  });

  test("revealed pro name beats the most-played name as the main name", () => {
    const rows = [
      row({
        pulseId: "a",
        pulseCharacterId: "1",
        name: "IIIIIIIIII",
        revealedName: "Star",
        games: 50,
        lastPlayed: "2026-06-01T00:00:00Z",
      }),
      row({
        pulseId: "b",
        pulseCharacterId: "2",
        name: "Casual",
        games: 2,
        lastPlayed: "2026-01-01T00:00:00Z",
      }),
    ];
    const links = { 1: link({ proId: "p1" }), 2: link({ proId: "p1" }) };
    const [g] = groupOpponentsByPlayer(rows, links);
    expect(g.name).toBe("Star");
    expect(g.revealedName).toBe("Star");
    expect(g.aliasNames).toEqual(["IIIIIIIIII", "Casual"]);
  });

  test("barcode names lose to readable names for the main slot", () => {
    const rows = [
      row({
        pulseId: "a",
        pulseCharacterId: "1",
        name: "llIIllIIll",
        games: 40,
        lastPlayed: "2026-06-01T00:00:00Z",
      }),
      row({
        pulseId: "b",
        pulseCharacterId: "2",
        name: "RealName",
        games: 3,
        lastPlayed: "2026-05-01T00:00:00Z",
      }),
    ];
    const links = { 1: link({ accountId: "acc" }), 2: link({ accountId: "acc" }) };
    const [g] = groupOpponentsByPlayer(rows, links);
    expect(g.name).toBe("RealName");
    expect(g.aliasNames).toEqual(["llIIllIIll"]);
  });

  test("identities are ordered newest first; duplicate names dedupe", () => {
    const rows = [
      row({
        pulseId: "a",
        pulseCharacterId: "1",
        name: "Same",
        games: 2,
        lastPlayed: "2026-01-01T00:00:00Z",
      }),
      row({
        pulseId: "b",
        pulseCharacterId: "2",
        name: "Same",
        games: 4,
        lastPlayed: "2026-03-01T00:00:00Z",
      }),
    ];
    const links = { 1: link({ accountId: "acc" }), 2: link({ accountId: "acc" }) };
    const [g] = groupOpponentsByPlayer(rows, links);
    expect(g.identities.map((i) => i.pulseId)).toEqual(["b", "a"]);
    expect(g.name).toBe("Same");
    expect(g.aliasNames).toEqual([]);
  });

  test("rows without a resolved character id never merge", () => {
    const rows = [
      row({ pulseId: "a", name: "NoCid", games: 1 }),
      row({ pulseId: "b", name: "NoCid", games: 1 }),
    ];
    const links = {};
    expect(groupOpponentsByPlayer(rows, links)).toHaveLength(2);
  });
});

describe("groupMatchesSearch", () => {
  const rows = [
    row({
      pulseId: "1-S2-1-111",
      pulseCharacterId: "1",
      toonHandle: "1-S2-1-111",
      name: "Fresh",
      games: 1,
      lastPlayed: "2026-06-01T00:00:00Z",
    }),
    row({
      pulseId: "1-S2-1-222",
      pulseCharacterId: "2",
      toonHandle: "1-S2-1-222",
      name: "OldAlias",
      revealedName: "Star",
      games: 9,
      lastPlayed: "2026-01-01T00:00:00Z",
    }),
  ];
  const links = { 1: link({ accountId: "acc" }), 2: link({ accountId: "acc" }) };
  const [group] = groupOpponentsByPlayer(rows, links);

  test("matches the hidden alias identity, not just the main name", () => {
    expect(groupMatchesSearch(group, "oldalias")).toBe(true);
    expect(groupMatchesSearch(group, "fresh")).toBe(true);
  });

  test("matches revealed name, ids, and toon handles", () => {
    expect(groupMatchesSearch(group, "star")).toBe(true);
    expect(groupMatchesSearch(group, "1-s2-1-222")).toBe(true);
    expect(groupMatchesSearch(group, "2")).toBe(true);
  });

  test("empty query matches; unrelated query doesn't", () => {
    expect(groupMatchesSearch(group, "  ")).toBe(true);
    expect(groupMatchesSearch(group, "zzz")).toBe(false);
  });
});
