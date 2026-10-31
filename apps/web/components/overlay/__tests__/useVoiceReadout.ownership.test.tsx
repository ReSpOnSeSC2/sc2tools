import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useVoiceReadout, type VoicePrefs } from "../useVoiceReadout";
import { useScoutingVoiceClaim } from "../useScoutingVoiceClaim";
import type { LiveGameEnvelope } from "../types";
import type { LiveGamePayload } from "../types";
import type { Socket } from "socket.io-client";

const READY: LiveGameEnvelope = {
  type: "liveGameState", phase: "match_started", gameKey: "canonical-match", capturedAt: 1,
  opponent: { name: "Alice", race: "Zerg", profile: { mmr: 4200 } },
  streamerHistory: { oppName: "Alice", headToHead: { wins: 2, losses: 1 } },
};
const PREFS: VoicePrefs = { enabled: true, delayMs: 0 };

describe("shared automatic scouting voice ownership", () => {
  let speak: ReturnType<typeof vi.fn>;
  let cancel: ReturnType<typeof vi.fn>;
  let voices: SpeechSynthesisVoice[];
  beforeEach(() => {
    vi.useFakeTimers();
    window.localStorage.setItem("sc2tools.voiceUnlocked", "1");
    window.sessionStorage.clear();
    voices = [];
    speak = vi.fn();
    cancel = vi.fn();
    vi.stubGlobal("speechSynthesis", {
      speak, cancel, getVoices: () => voices, addEventListener() {}, removeEventListener() {},
      speaking: false, paused: false,
    });
    vi.stubGlobal("SpeechSynthesisUtterance", class {
      constructor(public text: string) {}
      rate = 1; pitch = 1; volume = 1; lang = ""; voice = null; onerror = null;
    });
  });
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    window.sessionStorage.clear();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  const flush = async (ms = 0) => {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  };

  it("lets only one concurrent browser reader speak the same canonical match", async () => {
    const consumed = new Set<string>();
    const claim = vi.fn(async (gameKey: string) => {
      if (consumed.has(gameKey)) return false;
      consumed.add(gameKey);
      return true;
    });
    renderHook(() => {
      useVoiceReadout(null, PREFS, READY, claim);
      useVoiceReadout(null, PREFS, READY, claim);
    });
    await flush();
    expect(claim.mock.calls).toEqual([["canonical-match"], ["canonical-match"]]);
    expect(speak).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("does not claim until a queued reader receives its speech gesture", async () => {
    window.localStorage.clear();
    const claim = vi.fn(async () => true);
    const { result } = renderHook(() => useVoiceReadout(null, PREFS, READY, claim));
    await flush(6000);
    expect(result.current.needsGesture).toBe(true);
    expect(claim).not.toHaveBeenCalled();
    expect(speak).not.toHaveBeenCalled();
    act(() => result.current.onUserGesture());
    await flush();
    expect(claim.mock.calls).toEqual([["canonical-match"]]);
    expect(speak).toHaveBeenCalledTimes(1);
  });

  it("waits for configured delay and voice catalog before claiming", async () => {
    const claim = vi.fn(async () => true);
    renderHook(() => useVoiceReadout(null, { ...PREFS, voice: "Chosen voice", delayMs: 500 }, READY, claim));
    await flush(500);
    expect(claim).not.toHaveBeenCalled();
    voices = [{ name: "Chosen voice", lang: "en-US" } as SpeechSynthesisVoice];
    await flush(100);
    expect(claim.mock.calls).toEqual([["canonical-match"]]);
    expect(speak).toHaveBeenCalledTimes(1);
  });

  it.each(["denied", "failed"])("stays silent when shared ownership is %s", async outcome => {
    const claim = vi.fn(() => outcome === "failed" ? Promise.reject(new Error("offline")) : Promise.resolve(false));
    const { rerender } = renderHook(({ game }) => useVoiceReadout(null, PREFS, game, claim), { initialProps: { game: READY } });
    await flush();
    rerender({ game: { ...READY } });
    await flush();
    expect(claim).toHaveBeenCalledTimes(1);
    expect(speak).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it.each(["disabled", "unmounted"])("cancels delayed work when %s", async action => {
    const claim = vi.fn(async () => true);
    const { rerender, unmount } = renderHook(({ prefs }) => useVoiceReadout(null, prefs, READY, claim), {
      initialProps: { prefs: { ...PREFS, delayMs: 500 } },
    });
    if (action === "disabled") rerender({ prefs: { ...PREFS, delayMs: 500, enabled: false } });
    else unmount();
    await flush(2000);
    expect(claim).not.toHaveBeenCalled();
    expect(speak).not.toHaveBeenCalled();
  });

  it("does not play a granted response that arrives after voice is disabled", async () => {
    let resolveClaim!: (granted: boolean) => void;
    const claim = vi.fn(() => new Promise<boolean>(resolve => { resolveClaim = resolve; }));
    const { rerender } = renderHook(({ prefs }) => useVoiceReadout(null, prefs, READY, claim), { initialProps: { prefs: PREFS } });
    expect(claim).toHaveBeenCalledTimes(1);
    rerender({ prefs: { ...PREFS, enabled: false } });
    resolveClaim(true);
    await flush();
    expect(speak).not.toHaveBeenCalled();
  });

  it("ignores a late grant after the envelope clears with a resultless payload retained", async () => {
    let resolveClaim!: (granted: boolean) => void;
    const claim = vi.fn(() => new Promise<boolean>(resolve => { resolveClaim = resolve; }));
    const live: LiveGamePayload = { gameKey: "canonical-match", oppName: "Alice" };
    const { rerender } = renderHook(({ game }) => useVoiceReadout(live, PREFS, game, claim), {
      initialProps: { game: READY as LiveGameEnvelope | null },
    });
    expect(claim).toHaveBeenCalledTimes(1);
    rerender({ game: null });
    resolveClaim(true);
    await flush();
    expect(speak).not.toHaveBeenCalled();
    rerender({ game: null });
    await flush();
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it("drops queued scouting when its active envelope clears before gesture", async () => {
    window.localStorage.clear();
    const claim = vi.fn(async () => true);
    const { result, rerender } = renderHook(({ game }) => useVoiceReadout(null, PREFS, game, claim), {
      initialProps: { game: READY as LiveGameEnvelope | null },
    });
    rerender({ game: null });
    act(() => result.current.onUserGesture());
    await flush();
    expect(claim).not.toHaveBeenCalled();
    expect(speak).not.toHaveBeenCalled();
  });

  it("waits for a canonical game key instead of claiming a local legacy alias", async () => {
    const claim = vi.fn(async () => true);
    const { rerender } = renderHook(({ game }) => useVoiceReadout(null, PREFS, game, claim), {
      initialProps: { game: { ...READY, gameKey: undefined } as LiveGameEnvelope },
    });
    await flush(6000);
    expect(claim).not.toHaveBeenCalled();
    rerender({ game: READY });
    await flush();
    expect(claim.mock.calls).toEqual([["canonical-match"]]);
    expect(speak).toHaveBeenCalledTimes(1);
  });

  it("never claims a stale payload's key for a keyless new envelope", async () => {
    const claim = vi.fn(async () => true);
    const stale: LiveGamePayload = { oppName: "Alice", gameKey: "previous-match" };
    const { rerender } = renderHook(({ game }) => useVoiceReadout(stale, PREFS, game, claim), {
      initialProps: { game: { ...READY, gameKey: undefined } as LiveGameEnvelope },
    });
    await flush(6000);
    expect(claim).not.toHaveBeenCalled();
    rerender({ game: READY });
    await flush();
    expect(claim.mock.calls).toEqual([["canonical-match"]]);
    expect(speak).toHaveBeenCalledTimes(1);
  });

  it("keeps sample and post-game speech outside the automatic scouting claim", async () => {
    const claim = vi.fn(async () => false);
    const { unmount } = renderHook(() => useVoiceReadout({ isTest: true, gameKey: "sample", oppName: "Sample" }, PREFS, null, claim));
    await flush();
    expect(speak).toHaveBeenCalledTimes(1);
    unmount();
    renderHook(() => useVoiceReadout({ result: "win", mmrDelta: 22 }, { ...PREFS, events: { matchEnd: true } }, null, claim));
    await flush();
    expect(speak).toHaveBeenCalledTimes(2);
    expect(claim).not.toHaveBeenCalled();
  });

  it("speaks an explicit sample after a real envelope clears on the same mounted reader", async () => {
    const claim = vi.fn(async () => true);
    const { rerender } = renderHook(({ game, live }) => useVoiceReadout(live, PREFS, game, claim), {
      initialProps: { game: READY as LiveGameEnvelope | null, live: null as LiveGamePayload | null },
    });
    await flush();
    expect(speak).toHaveBeenCalledTimes(1);
    rerender({ game: null, live: null });
    rerender({ game: null, live: { isTest: true, testNonce: "sample-after-game", oppName: "Sample" } });
    await flush();
    expect(speak).toHaveBeenCalledTimes(2);
    expect(speak.mock.calls[1][0].text).toContain("Facing Sample");
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it("keeps a later cheese alert independent of a denied scouting claim", async () => {
    const claim = vi.fn(async () => false);
    const prefs = { ...PREFS, events: { scouting: true, cheese: true } };
    const { rerender } = renderHook(({ live }) => useVoiceReadout(live, prefs, null, claim), {
      initialProps: { live: { oppName: "Alice", gameKey: "canonical-match" } as LiveGamePayload },
    });
    await flush();
    expect(speak).not.toHaveBeenCalled();
    rerender({ live: { oppName: "Alice", gameKey: "canonical-match", cheeseProbability: 0.6 } });
    await flush();
    expect(claim).toHaveBeenCalledTimes(1);
    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak.mock.calls[0][0].text).toContain("Cheese warning");
  });

  it("uses the socket acknowledgement and fails closed on timeout", async () => {
    let acknowledge!: (reply: { granted: boolean }) => void;
    const emit = vi.fn((_event, _payload, callback) => { acknowledge = callback; });
    const socketRef = { current: { connected: true, emit } as unknown as Socket };
    const { result } = renderHook(() => useScoutingVoiceClaim(socketRef));
    const accepted = result.current("canonical-match");
    expect(emit).toHaveBeenCalledWith("overlay:claimScoutingVoice", { gameKey: "canonical-match" }, expect.any(Function));
    acknowledge({ granted: true });
    await expect(accepted).resolves.toBe(true);
    const unanswered = result.current("next-match");
    await flush(2000);
    await expect(unanswered).resolves.toBe(false);
  });
});
