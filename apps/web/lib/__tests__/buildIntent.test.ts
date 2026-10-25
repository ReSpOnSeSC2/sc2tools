import { afterEach, describe, expect, it, vi } from "vitest";

const apiCallMock = vi.fn();

vi.mock("@/lib/clientApi", () => ({
  apiCall: (...args: unknown[]) => apiCallMock(...args),
  useApi: vi.fn(),
}));

import {
  BUILD_CHECKIN_PREFS_PATH,
  buildIntentErrorCode,
  buildIntentErrorMessage,
  buildOptionsPath,
  checkinsText,
  confirmGameIntent,
  customBuildKey,
  defaultNewBuildName,
  dismissPendingIntents,
  effectiveBuild,
  effectiveOpponentBuild,
  gameIntentPath,
  groupBuildOptions,
  matchupFromRaces,
  mergeIntentUpdate,
  NEW_BUILD_CHECKIN_FAILED,
  NEW_BUILD_NOT_CHECKED_IN,
  newBuildCheckinFailure,
  newBuildHref,
  opponentCurrentKey,
  pendingIntentsPath,
  plannedTooltip,
  putCheckinPrefs,
  recordText,
  sanitizeCheckinPrefs,
  saveGameIntentNotes,
  setOpponentBuild,
  skipGameIntent,
  suggestionReasonLabel,
  winRate,
  winRateText,
  withRevision,
  type BuildOption,
  type GameIntentState,
  type OpponentIntentState,
} from "../buildIntent";

const getToken = async () => "token";

afterEach(() => {
  apiCallMock.mockReset();
});

function option(overrides: Partial<BuildOption>): BuildOption {
  return {
    key: "pvz-stargate",
    name: "PvZ - Stargate",
    slug: null,
    source: "catalog",
    games: 0,
    wins: 0,
    losses: 0,
    checkins: 0,
    lastPlayedAt: null,
    inRandomizer: false,
    group: "all",
    ...overrides,
  };
}

describe("paths", () => {
  it("encodes the game id and only asks for options on request", () => {
    expect(gameIntentPath("2026|Foo Bar")).toBe(
      "/v1/games/2026%7CFoo%20Bar/build-intent",
    );
    expect(gameIntentPath("g1", { includeOptions: true })).toBe(
      "/v1/games/g1/build-intent?include=options",
    );
  });

  it("clamps the pending limit to 1–25", () => {
    expect(pendingIntentsPath()).toBe("/v1/build-intents/pending?limit=10");
    expect(pendingIntentsPath(0)).toBe("/v1/build-intents/pending?limit=1");
    expect(pendingIntentsPath(99)).toBe("/v1/build-intents/pending?limit=25");
  });

  it("only builds an options path for a concrete matchup", () => {
    expect(buildOptionsPath("PvZ")).toBe("/v1/build-intents/options?matchup=PvZ");
    expect(buildOptionsPath("PvZ", "you")).toBe("/v1/build-intents/options?matchup=PvZ");
    expect(buildOptionsPath("PvZ", "opponent")).toBe(
      "/v1/build-intents/options?matchup=PvZ&side=opponent",
    );
    expect(buildOptionsPath("PvR")).toBeNull();
    expect(buildOptionsPath(null, "opponent")).toBeNull();
  });

  it("builds custom keys and the new-build deep link", () => {
    expect(customBuildKey("dt-3-gate")).toBe("custom:dt-3-gate");
    expect(newBuildHref("a|b", "opponent")).toBe("/app/game/a%7Cb?newBuild=opponent");
  });

  it("folds the revision into a fragment the API never sees", () => {
    expect(withRevision("/v1/build-intents/pending?limit=1", 4)).toBe(
      "/v1/build-intents/pending?limit=1#checkin-4",
    );
  });
});

describe("mutations", () => {
  it("confirms with the build key and only sends notes when given", async () => {
    apiCallMock.mockResolvedValue({ gameId: "g1" });
    await confirmGameIntent(getToken, "a|b", "custom:dt-rush");
    await confirmGameIntent(getToken, "a|b", "pvz-stargate", "Got scouted");
    expect(apiCallMock).toHaveBeenNthCalledWith(1, getToken, "/v1/games/a%7Cb/build-intent", {
      method: "PUT",
      body: JSON.stringify({ action: "confirm", buildKey: "custom:dt-rush" }),
    });
    expect(JSON.parse(apiCallMock.mock.calls[1][2].body)).toEqual({
      action: "confirm",
      buildKey: "pvz-stargate",
      notes: "Got scouted",
    });
  });

  it("carries the opponent's build along with any write", async () => {
    apiCallMock.mockResolvedValue({ gameId: "g1" });
    await confirmGameIntent(getToken, "g1", "pvz-stargate", undefined, {
      opponentBuildKey: "zerg-12-pool",
    });
    await skipGameIntent(getToken, "g1", "notes", { opponentBuildKey: null });
    await confirmGameIntent(getToken, "g1", "pvz-stargate", undefined, {});
    expect(JSON.parse(apiCallMock.mock.calls[0][2].body)).toEqual({
      action: "confirm",
      buildKey: "pvz-stargate",
      opponentBuildKey: "zerg-12-pool",
    });
    expect(JSON.parse(apiCallMock.mock.calls[1][2].body)).toEqual({
      action: "skip",
      notes: "notes",
      opponentBuildKey: null,
    });
    expect(JSON.parse(apiCallMock.mock.calls[2][2].body)).toEqual({
      action: "confirm",
      buildKey: "pvz-stargate",
    });
  });

  it("corrects only the opponent's build, or resets it with null", async () => {
    apiCallMock.mockResolvedValue({ gameId: "g1" });
    await setOpponentBuild(getToken, "a|b", "custom:ling-flood");
    await setOpponentBuild(getToken, "g1", null, "Proxy hatch");
    expect(apiCallMock).toHaveBeenNthCalledWith(1, getToken, "/v1/games/a%7Cb/build-intent", {
      method: "PUT",
      body: JSON.stringify({ action: "opponent", opponentBuildKey: "custom:ling-flood" }),
    });
    expect(JSON.parse(apiCallMock.mock.calls[1][2].body)).toEqual({
      action: "opponent",
      opponentBuildKey: null,
      notes: "Proxy hatch",
    });
  });

  it("sends skip and notes actions", async () => {
    apiCallMock.mockResolvedValue({ gameId: "g1" });
    await skipGameIntent(getToken, "g1");
    await saveGameIntentNotes(getToken, "g1", "");
    expect(JSON.parse(apiCallMock.mock.calls[0][2].body)).toEqual({ action: "skip" });
    expect(JSON.parse(apiCallMock.mock.calls[1][2].body)).toEqual({
      action: "notes",
      notes: "",
    });
  });

  it("dismisses the pending window with a POST", async () => {
    apiCallMock.mockResolvedValue({ dismissed: 3 });
    await expect(dismissPendingIntents(getToken)).resolves.toEqual({ dismissed: 3 });
    expect(apiCallMock).toHaveBeenCalledWith(getToken, "/v1/build-intents/pending/dismiss", {
      method: "POST",
      body: "{}",
    });
  });

  it("writes exactly the three preference booleans", async () => {
    apiCallMock.mockResolvedValue({ enabled: false, askAtLoading: true, askAfterGame: false });
    const saved = await putCheckinPrefs(getToken, {
      enabled: false,
      askAtLoading: true,
      askAfterGame: false,
      extra: 1,
    } as never);
    expect(apiCallMock).toHaveBeenCalledWith(getToken, BUILD_CHECKIN_PREFS_PATH, {
      method: "PUT",
      body: JSON.stringify({ enabled: false, askAtLoading: true, askAfterGame: false }),
    });
    expect(saved).toEqual({ enabled: false, askAtLoading: true, askAfterGame: false });
  });
});

describe("sanitizeCheckinPrefs", () => {
  it("requires an explicit true for every check-in flag", () => {
    expect(sanitizeCheckinPrefs(undefined)).toEqual({
      enabled: false,
      askAtLoading: false,
      askAfterGame: false,
    });
    expect(sanitizeCheckinPrefs({ enabled: false, askAtLoading: "no" })).toEqual({
      enabled: false,
      askAtLoading: false,
      askAfterGame: false,
    });
    const optedIn = { enabled: true, askAtLoading: true, askAfterGame: true };
    expect(sanitizeCheckinPrefs(optedIn)).toEqual(optedIn);
    expect(sanitizeCheckinPrefs({ enabled: 1, askAtLoading: "true" })).toEqual({
      enabled: false, askAtLoading: false, askAfterGame: false,
    });
  });
});

describe("error copy", () => {
  it("maps check-in error codes to friendly messages", () => {
    expect(
      buildIntentErrorMessage({ status: 409, code: "not_eligible", message: "not_eligible" }),
    ).toMatch(/can't take a check-in/);
    expect(
      buildIntentErrorMessage({ status: 400, code: "unknown_build", message: "x" }),
    ).toMatch(/isn't available for this matchup/);
    expect(
      buildIntentErrorMessage({ status: 409, code: "already_bound", message: "x" }),
    ).toMatch(/already been uploaded/);
    expect(
      buildIntentErrorMessage({ status: 400, code: "invalid_notes", message: "x" }),
    ).toBe("Notes can be at most 1,000 characters.");
    expect(
      buildIntentErrorMessage({ status: 400, code: "unknown_opponent_build", message: "x" }),
    ).toBe("That opponent build isn't available for this matchup any more. Pick another one.");
    expect(
      buildIntentErrorMessage({ status: 409, code: "slug_taken", message: "x" }),
    ).toBe("You already have a build called that — pick another name");
  });

  it("keeps the humanised message for other codes and handles network failures", () => {
    expect(buildIntentErrorMessage({ status: 500, message: "Something broke." })).toBe(
      "Something broke.",
    );
    expect(buildIntentErrorMessage(new TypeError("Failed to fetch"))).toMatch(
      /API is unavailable/,
    );
    expect(buildIntentErrorCode({ status: 409, code: "not_eligible", message: "" })).toBe(
      "not_eligible",
    );
    expect(buildIntentErrorCode(new Error("x"))).toBeNull();
  });
});

describe("display helpers", () => {
  it("computes win rate from decided games only", () => {
    expect(winRate(7, 5)).toBeCloseTo(7 / 12);
    expect(winRate(0, 0)).toBeNull();
    expect(winRateText(7, 5)).toBe("58%");
    expect(winRateText(0, 0)).toBeNull();
    expect(recordText(7, 5)).toBe("7–5");
  });

  it("describes check-in counts and planned tooltips", () => {
    expect(checkinsText(0)).toBeNull();
    expect(checkinsText(undefined)).toBeNull();
    expect(checkinsText(1)).toBe("incl. 1 check-in");
    expect(checkinsText(3)).toBe("incl. 3 check-ins");
    expect(plannedTooltip("PvZ - Macro (Unclassified)")).toBe(
      "Replay classified as PvZ - Macro (Unclassified)",
    );
    expect(plannedTooltip(null)).toMatch(/no build label/);
  });

  it("labels each suggestion reason", () => {
    const base = { passedRules: null, ruleCount: null };
    expect(suggestionReasonLabel({ ...base, reason: "randomizer" })).toBe("Randomizer roll");
    expect(suggestionReasonLabel({ ...base, reason: "declared" })).toBe("Your pre-game pick");
    expect(suggestionReasonLabel({ ...base, reason: "detected" })).toBe(
      "Detected in the replay",
    );
    expect(
      suggestionReasonLabel({ reason: "rules", passedRules: 4, ruleCount: 5 }),
    ).toBe("4/5 rules matched");
    expect(suggestionReasonLabel({ ...base, reason: "usual" }, "PvZ")).toBe(
      "Your usual PvZ build",
    );
  });

  it("resolves the effective label and planned marker", () => {
    const confirmed = {
      status: "confirmed" as const,
      applied: true,
      build: { key: "custom:dt", name: "DT Rush", slug: "dt", source: "custom" as const },
      detected: { name: "PvZ - Macro (Unclassified)", slug: null, key: null },
    };
    expect(effectiveBuild(confirmed, "stale")).toEqual({
      label: "DT Rush",
      planned: { detected: "PvZ - Macro (Unclassified)" },
    });
    expect(
      effectiveBuild({ ...confirmed, status: "skipped", applied: false, build: null }, "stale"),
    ).toEqual({ label: "PvZ - Macro (Unclassified)", planned: null });
    expect(effectiveBuild(null, "Row label")).toEqual({ label: "Row label", planned: null });
  });

  it("groups options in server order and filters by name", () => {
    const options = [
      option({ key: "a", name: "Alpha", group: "yours" }),
      option({ key: "b", name: "Beta" }),
      option({ key: "c", name: "Gamma", group: "yours" }),
    ];
    expect(groupBuildOptions(options)).toEqual({
      yours: [options[0], options[2]],
      all: [options[1]],
    });
    expect(groupBuildOptions(options, " GAM ")).toEqual({ yours: [options[2]], all: [] });
  });

  it("derives a concrete matchup only", () => {
    expect(matchupFromRaces("Protoss", "zerg")).toBe("PvZ");
    expect(matchupFromRaces("Random", "Zerg")).toBeNull();
    expect(matchupFromRaces(null, "Zerg")).toBeNull();
  });
});

describe("opponent axis", () => {
  const opponent = (overrides: Partial<OpponentIntentState> = {}): OpponentIntentState => ({
    label: "Zerg - 12 Pool",
    status: "none",
    build: null,
    applied: false,
    detected: { name: "Zerg - 12 Pool", slug: null, key: "zerg-12-pool" },
    suggestion: null,
    executed: null,
    ...overrides,
  });
  const corrected = opponent({
    label: "Ling Flood",
    status: "confirmed",
    applied: true,
    build: { key: "custom:ling-flood", name: "Ling Flood", slug: "ling-flood", source: "custom" },
  });

  it("resolves the opponent's effective build and its Corrected marker", () => {
    expect(effectiveOpponentBuild(corrected, "stale")).toEqual({
      label: "Ling Flood",
      corrected: { detected: "Zerg - 12 Pool" },
    });
    expect(effectiveOpponentBuild(opponent(), "stale")).toEqual({
      label: "Zerg - 12 Pool",
      corrected: null,
    });
    expect(effectiveOpponentBuild(opponent({ label: null, detected: null }), "Row")).toEqual({
      label: "Row",
      corrected: null,
    });
    expect(effectiveOpponentBuild(null, "Row")).toEqual({ label: "Row", corrected: null });
  });

  it("starts the picker on the correction, else on the replay's label", () => {
    expect(opponentCurrentKey(corrected)).toBe("custom:ling-flood");
    expect(opponentCurrentKey(opponent())).toBe("zerg-12-pool");
    expect(opponentCurrentKey(opponent({ detected: null }))).toBeNull();
    expect(opponentCurrentKey(undefined)).toBeNull();
  });

  it("keeps both loaded build lists when a write response arrives", () => {
    const yours = [option({ key: "pvz-stargate" })];
    const theirs = [option({ key: "zerg-12-pool", name: "Zerg - 12 Pool" })];
    const current = {
      gameId: "g1",
      options: yours,
      usualKey: "pvz-stargate",
      opponent: opponent({ options: theirs }),
    } as GameIntentState;
    const next = { gameId: "g1", opponent: corrected } as GameIntentState;
    expect(mergeIntentUpdate(current, next)).toMatchObject({
      options: yours,
      usualKey: "pvz-stargate",
      opponent: { ...corrected, options: theirs },
    });
    // A game without a matchup keeps `opponent: null`; an older API's
    // response without the field keeps what was loaded.
    expect(mergeIntentUpdate(current, { gameId: "g1", opponent: null } as GameIntentState).opponent)
      .toBeNull();
    expect(mergeIntentUpdate(current, { gameId: "g1" } as GameIntentState).opponent).toEqual(
      current.opponent,
    );
    expect(mergeIntentUpdate(undefined, next).opponent).toEqual(corrected);
  });
});

describe("Add new build copy", () => {
  it("names a new build after the matchup or the opponent's race", () => {
    expect(defaultNewBuildName("you", "Protoss", "Zerg")).toBe("PvZ — New build");
    expect(defaultNewBuildName("opponent", "Protoss", "Zerg")).toBe("Zerg build vs Protoss");
    expect(defaultNewBuildName("opponent", "P", "T")).toBe("Terran build vs Protoss");
    expect(defaultNewBuildName("you", null, "Zerg")).toBe("New build");
    expect(defaultNewBuildName("opponent", null, "Zerg")).toBe("Zerg build");
    expect(defaultNewBuildName("opponent", "Protoss", "Random")).toBe("Opponent build");
  });

  it("explains why a saved build didn't become the check-in", () => {
    expect(newBuildCheckinFailure("unknown_build", "x")).toEqual({
      title: NEW_BUILD_NOT_CHECKED_IN,
      reason: "It doesn't fit this game's matchup.",
    });
    expect(newBuildCheckinFailure("unknown_opponent_build", "x").title).toBe(
      NEW_BUILD_NOT_CHECKED_IN,
    );
    expect(newBuildCheckinFailure("not_eligible", "x", "too_short")).toEqual({
      title: NEW_BUILD_NOT_CHECKED_IN,
      reason: "Games under 45 seconds never count toward a build.",
    });
    expect(newBuildCheckinFailure("not_eligible", "x").reason).toMatch(/can't take a check-in/);
    expect(newBuildCheckinFailure("rate_limited", "Too many changes.")).toEqual({
      title: NEW_BUILD_CHECKIN_FAILED,
      reason: "Too many changes.",
    });
    expect(NEW_BUILD_NOT_CHECKED_IN).toBe(
      "Saved to your library, but this game can't take it as its check-in",
    );
  });
});
