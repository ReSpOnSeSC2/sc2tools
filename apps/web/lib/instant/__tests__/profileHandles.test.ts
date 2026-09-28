import { describe, expect, it, vi } from "vitest";
import {
  MAX_PULSE_IDS,
  PROFILE_PUT_KEYS,
  mergeProfileWithToons,
  profileToons,
  saveConfirmedToons,
  type ApiCallFn,
} from "../profileHandles";

const ME = "1-S2-1-267727";
const ALT = "2-S2-1-111";

const FULL_PROFILE = {
  battleTag: "ReSpOnSe#1234",
  battleTags: ["ReSpOnSe#1234"],
  pulseId: "340543",
  pulseIds: ["340543", ME],
  region: "us",
  preferredRace: "Protoss",
  displayName: "ReSpOnSe",
  lastKnownMmr: 5326,
  lastKnownMmrAt: "2026-05-08T19:08:12Z",
  lastKnownMmrRegion: "NA",
  detectedPulseIds: [ALT],
};

describe("profileToons", () => {
  it("collects toon handles from pulseIds and detectedPulseIds", () => {
    expect(profileToons(FULL_PROFILE)).toEqual([ME, ALT]);
    expect(profileToons(null)).toEqual([]);
    expect(profileToons({ pulseIds: "nope" })).toEqual([]);
  });
});

describe("mergeProfileWithToons", () => {
  it("never drops an accepted field and sends only accepted keys", () => {
    const body = mergeProfileWithToons(FULL_PROFILE, ["3-S2-1-7"]);
    expect(body).toEqual({
      battleTag: "ReSpOnSe#1234",
      pulseId: "340543",
      pulseIds: ["340543", ME, "3-S2-1-7"],
      region: "us",
      preferredRace: "Protoss",
      displayName: "ReSpOnSe",
      lastKnownMmr: 5326,
      lastKnownMmrAt: "2026-05-08T19:08:12Z",
      lastKnownMmrRegion: "NA",
    });
    expect(Object.keys(body ?? {}).every((k) => PROFILE_PUT_KEYS.some((key) => key === k))).toBe(true);
  });

  it("is a no-op when every toon is already saved", () => {
    expect(mergeProfileWithToons(FULL_PROFILE, [ME, ` ${ME} `])).toBeNull();
    expect(mergeProfileWithToons(FULL_PROFILE, [])).toBeNull();
    expect(mergeProfileWithToons(FULL_PROFILE, ["not-a-toon"])).toBeNull();
  });

  it("dedupes and keeps pulseIds within 20", () => {
    const nineteen = Array.from({ length: 19 }, (_, i) => `1-S2-1-${i}`);
    const body = mergeProfileWithToons({ pulseIds: [...nineteen, nineteen[0]] }, [ME, ALT, ME]);
    expect(body?.pulseIds).toEqual([...nineteen, ME]);
    expect(Array.isArray(body?.pulseIds) && body.pulseIds.length).toBe(MAX_PULSE_IDS);
    const full = Array.from({ length: 20 }, (_, i) => `1-S2-1-${i}`);
    expect(mergeProfileWithToons({ pulseIds: full }, [ME])).toBeNull();
  });

  it("keeps the legacy pulseId first and mirrors pulseIds[0]", () => {
    expect(mergeProfileWithToons({ pulseId: "340543" }, [ME])).toEqual({
      pulseId: "340543",
      pulseIds: ["340543", ME],
    });
    expect(mergeProfileWithToons({}, [ME])).toEqual({ pulseId: ME, pulseIds: [ME] });
  });

  it("drops values whose type the PUT schema would refuse", () => {
    const odd = { region: 1, lastKnownMmr: "5326", displayName: ["x"], battleTag: "A#1", pulseIds: [ME, 7] };
    expect(mergeProfileWithToons(odd, [ALT])).toEqual({
      battleTag: "A#1",
      pulseId: ME,
      pulseIds: [ME, ALT],
    });
  });

  it("skips null values instead of sending them", () => {
    expect(mergeProfileWithToons({ battleTag: null, region: "eu" }, [ME])).toEqual({
      region: "eu",
      pulseId: ME,
      pulseIds: [ME],
    });
  });
});

describe("saveConfirmedToons", () => {
  function mockApiCall(profile: unknown) {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    // Mock of lib/clientApi apiCall: GET returns the profile, PUT echoes nothing.
    const impl = vi.fn(async (_getToken: () => Promise<string | null>, path: string, init?: RequestInit) => {
      calls.push({ path, init });
      return init?.method === "PUT" ? null : profile;
    });
    // ApiCallFn is generic in its result type (`Promise<T>`); a mock that
    // returns canned JSON can only satisfy it through a cast.
    return { apiCallImpl: impl as ApiCallFn, calls };
  }

  it("GETs, merges and PUTs only when something changed", async () => {
    const { apiCallImpl, calls } = mockApiCall(FULL_PROFILE);
    const result = await saveConfirmedToons(async () => "t", ["3-S2-1-7"], apiCallImpl);
    expect(result.changed).toBe(true);
    expect(calls.map((c) => c.init?.method ?? "GET")).toEqual(["GET", "PUT"]);
    const sent: unknown = JSON.parse(String(calls[1].init?.body));
    expect(sent).toMatchObject({ battleTag: "ReSpOnSe#1234", displayName: "ReSpOnSe", lastKnownMmr: 5326 });
    expect(sent).not.toHaveProperty("detectedPulseIds");
    expect(sent).not.toHaveProperty("battleTags");
  });

  it("does not PUT when the toon is already present", async () => {
    const { apiCallImpl, calls } = mockApiCall(FULL_PROFILE);
    const result = await saveConfirmedToons(async () => "t", [ME], apiCallImpl);
    expect(result).toEqual({ changed: false, pulseIds: ["340543", ME] });
    expect(calls).toHaveLength(1);
  });
});
