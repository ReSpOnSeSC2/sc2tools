import { describe, expect, it } from "vitest";
import { missingOverrideIds, overrideCandidates } from "../components/GuideVideoOverrides";
import {
  adminErrorText,
  clampBackfillDays,
  guideNoteApiPath,
  selectionFor,
  toggleHidden,
  togglePinned,
  withDraft,
} from "../components/guidesAdminShared";
import { statusPollInterval } from "../components/useGuidesAdmin";
import {
  ADMIN_VIDEOS,
  ADMIN_VIDEO_8_POOLS,
  ADMIN_VIDEO_CARRIERS,
  ADMIN_VIDEO_GLAIVES,
  ADMIN_VIDEO_PVT_CHARGE,
  STARGATE_GLAIVES,
  statusFixture,
} from "./adminGuidesFixtures";

describe("clampBackfillDays", () => {
  it.each([
    ["30", 30],
    [" 45 ", 45],
    ["0", 1],
    ["-5", 1],
    ["999", 400],
    ["", 90],
    ["abc", 90],
  ])("clampBackfillDays(%j) → %d", (raw, expected) => {
    expect(clampBackfillDays(raw)).toBe(expected);
  });
});

describe("guide video override toggles", () => {
  const id = ADMIN_VIDEO_GLAIVES.youtubeId;

  it("pinning appends and un-hides; un-pinning removes", () => {
    const pinned = togglePinned({ pinned: ["x1x1x1x1x1x"], hidden: [id] }, id);
    expect(pinned).toEqual({ pinned: ["x1x1x1x1x1x", id], hidden: [] });
    expect(togglePinned(pinned, id)).toEqual({ pinned: ["x1x1x1x1x1x"], hidden: [] });
  });

  it("hiding un-pins; un-hiding removes", () => {
    const hidden = toggleHidden({ pinned: [id], hidden: [] }, id);
    expect(hidden).toEqual({ pinned: [], hidden: [id] });
    expect(toggleHidden(hidden, id)).toEqual({ pinned: [], hidden: [] });
  });
});

describe("overrideCandidates", () => {
  const selection = { matchup: "PvZ" as const, buildKey: STARGATE_GLAIVES };

  it("keeps the matchup's videos: pinned first, then auto matches, then API order", () => {
    const out = overrideCandidates(ADMIN_VIDEOS, selection, { pinned: [ADMIN_VIDEO_8_POOLS.youtubeId], hidden: [] });
    expect(out.map((v) => v.youtubeId)).toEqual([
      ADMIN_VIDEO_8_POOLS.youtubeId,
      ADMIN_VIDEO_GLAIVES.youtubeId,
      ADMIN_VIDEO_CARRIERS.youtubeId,
    ]);
  });

  it("includes another matchup's video once it is pinned or hidden on this guide", () => {
    const out = overrideCandidates(ADMIN_VIDEOS, selection, { pinned: [], hidden: [ADMIN_VIDEO_PVT_CHARGE.youtubeId] });
    expect(out.map((v) => v.youtubeId)).toContain(ADMIN_VIDEO_PVT_CHARGE.youtubeId);
  });
});

describe("missingOverrideIds", () => {
  it("returns saved ids that have no stored video, pinned first", () => {
    const overrides = { pinned: ["zzzzzzzzzzz", ADMIN_VIDEO_GLAIVES.youtubeId], hidden: ["yyyyyyyyyyy"] };
    expect(missingOverrideIds(ADMIN_VIDEOS, overrides)).toEqual(["zzzzzzzzzzz", "yyyyyyyyyyy"]);
    expect(missingOverrideIds(ADMIN_VIDEOS, { pinned: [ADMIN_VIDEO_GLAIVES.youtubeId], hidden: [] })).toEqual([]);
  });
});

describe("withDraft", () => {
  it("stores a changed draft and drops one equal to the stored body", () => {
    expect(withDraft({}, "k", "### Plan", "")).toEqual({ k: "### Plan" });
    expect(withDraft({ k: "x", other: "y" }, "k", "stored", "stored")).toEqual({ other: "y" });
    expect(withDraft({ k: "x" }, "k", "", "")).toEqual({});
  });
});

describe("guides admin helpers", () => {
  it("builds the notes path from the catalog slug", () => {
    expect(guideNoteApiPath("PvZ", STARGATE_GLAIVES)).toBe("/v1/admin/guides/notes/pvz/stargate-into-glaives");
    expect(guideNoteApiPath("PvZ", "Zerg - 12 Pool")).toBeNull();
  });

  it("defaults the selection to the matchup's first catalog build", () => {
    expect(selectionFor("PvZ")).toEqual({ matchup: "PvZ", buildKey: "PvZ - 2 Stargate Phoenix" });
  });

  it("polls the status only while a job runs", () => {
    expect(statusPollInterval(undefined)).toBe(0);
    expect(statusPollInterval(statusFixture())).toBe(0);
    expect(statusPollInterval(statusFixture({ running: true }))).toBe(5000);
    const recomputing = { ...statusFixture(), recompute: { running: true, requestedAt: null, last: null } };
    expect(statusPollInterval(recomputing)).toBe(5000);
  });

  it("maps API error codes to actionable copy", () => {
    expect(adminErrorText("Couldn't sync.", { status: 502, code: "feed_http_500", message: "x" })).toBe(
      "Couldn't sync. Couldn't read the channel feed from YouTube. Try again in a few minutes.",
    );
    expect(adminErrorText("Couldn't save.", { status: 403, code: "admin_only", message: "x" })).toBe(
      "Couldn't save. Your account isn't an admin.",
    );
    expect(adminErrorText("Couldn't save.", new Error("boom"))).toBe("Couldn't save. Try again in a moment.");
  });
});
