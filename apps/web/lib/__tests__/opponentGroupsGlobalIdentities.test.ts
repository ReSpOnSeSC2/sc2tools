import { describe, expect, test } from "vitest";
import {
  groupMatchesSearch,
  groupOpponentsByPlayer,
  type GlobalPlayerIdentity,
  type GroupableOpponent,
} from "../opponentGroups";

const approved: GlobalPlayerIdentity = {
  groupKey: "pro:42", displayName: "KnownPlayer", revision: 1,
  target: { key: "toon:2-S2-1-22222", toonHandle: "2-S2-1-22222" },
};

function row(pulseId: string, name: string, globalIdentity?: GlobalPlayerIdentity): GroupableOpponent {
  return { pulseId, name, globalIdentity, games: 1, wins: 1, losses: 0, winRate: 1, lastPlayed: null };
}

describe("approved global opponent grouping", () => {
  test("joins exact approved groups while preserving barcode evidence and excluding identical nicknames", () => {
    const source = row("1-S2-1-11111", "IIlIIlIl", approved);
    const target = row("2-S2-1-22222", "MainAccount", approved);
    const unrelated = row("1-S2-1-44444", "IIlIIlIl");
    const groups = groupOpponentsByPlayer([source, target, unrelated], null);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ name: "KnownPlayer", games: 2, groupSize: 2 });
    expect(groups[0].identities).toEqual([source, target]);
    expect(groups[0].aliasNames).toEqual(["IIlIIlIl", "MainAccount"]);
    expect(groupMatchesSearch(groups[0], "KnownPlayer")).toBe(true);
    expect(groupMatchesSearch(groups[0], "IIlIIlIl")).toBe(true);
    expect(groupMatchesSearch(groups[0], "2-S2-1-22222")).toBe(true);
    expect(source.name).toBe("IIlIIlIl");
  });

  test("approved labels appear for singletons and grouping off still keeps accounts separate", () => {
    const rows = [row("source", "IIlIIlIl", approved), row("target", "MainAccount", approved)];
    const singleton = groupOpponentsByPlayer(rows.slice(0, 1))[0];
    expect(singleton.name).toBe("KnownPlayer");
    expect(singleton.aliasNames).toEqual(["IIlIIlIl"]);
    const separate = groupOpponentsByPlayer(rows, null, false);
    expect(separate).toHaveLength(2);
    expect(separate.every((group) => group.name === "KnownPlayer" && group.groupSize === 1)).toBe(true);
  });

  test("approved keys and labels take precedence over stale Pulse grouping", () => {
    const source = { ...row("source", "IIlIIlIl", approved), pulseCharacterId: "111", revealedName: "OldLabel" };
    const target = row("target", "MainAccount", approved);
    const unrelated = { ...row("other", "Other"), pulseCharacterId: "444" };
    const oldLink = { proId: "stale", accountId: null, proNickname: "OldLabel" };
    const groups = groupOpponentsByPlayer([source, target, unrelated], { 111: oldLink, 444: oldLink });
    expect(groups).toHaveLength(2);
    expect(groups[0].name).toBe("KnownPlayer");
    expect(groups[0].identities).toEqual([source, target]);
  });

  test("unlinking removes approved names and merges without mutating input rows", () => {
    const source = row("source", "IIlIIlIl", approved);
    const before = groupOpponentsByPlayer([source])[0];
    const after = groupOpponentsByPlayer([{ ...source, globalIdentity: undefined }])[0];
    expect(before.name).toBe("KnownPlayer");
    expect(after.name).toBe("IIlIIlIl");
    expect(after.aliasNames).toEqual([]);
  });
});
