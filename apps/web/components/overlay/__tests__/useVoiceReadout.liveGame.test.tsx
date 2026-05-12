import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { act, render } from "@testing-library/react";
import { useEffect } from "react";
import { useVoiceReadout, type VoicePrefs } from "../useVoiceReadout";
import type { LiveGameEnvelope, LiveGamePayload } from "../types";

/* ------------------------------------------------------------------
 * Web Speech mock — lifted from useVoiceReadout.hook.test.tsx so we
 * exercise the same surface but feed the hook the agent's pre-game
 * envelope rather than a post-game payload.
 * ------------------------------------------------------------------ */
type Capture = {
  speak: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  utterances: SpeechSynthesisUtterance[];
};

function installSpeechSynthMock(): Capture {
  const utterances: SpeechSynthesisUtterance[] = [];
  const speak = vi.fn((u: SpeechSynthesisUtterance) => {
    utterances.push(u);
  });
  const cancel = vi.fn();
  const fakeSynth = {
    speak,
    cancel,
    paused: false,
    speaking: false,
    pending: false,
    resume: vi.fn(),
    pause: vi.fn(),
    getVoices: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
    onvoiceschanged: null,
  } as unknown as SpeechSynthesis;
  Object.defineProperty(window, "speechSynthesis", {
    value: fakeSynth,
    configurable: true,
    writable: true,
  });
  if (typeof window.SpeechSynthesisUtterance === "undefined") {
    class FakeUtt {
      text: string;
      rate = 1;
      pitch = 1;
      volume = 1;
      lang = "";
      voice: SpeechSynthesisVoice | null = null;
      onerror: ((ev: Event) => void) | null = null;
      onend: ((ev: Event) => void) | null = null;
      onstart: ((ev: Event) => void) | null = null;
      constructor(text: string) {
        this.text = text;
      }
    }
    (window as unknown as { SpeechSynthesisUtterance: typeof FakeUtt })
      .SpeechSynthesisUtterance = FakeUtt;
    (globalThis as unknown as { SpeechSynthesisUtterance: typeof FakeUtt })
      .SpeechSynthesisUtterance = FakeUtt;
  }
  return { speak, cancel, utterances };
}

function clearSessionUnlock() {
  try {
    window.localStorage.removeItem("sc2tools.voiceUnlocked");
  } catch {
    /* ignore */
  }
  try {
    window.sessionStorage.removeItem("sc2tools.voiceUnlocked");
  } catch {
    /* ignore */
  }
}

type HarnessRef = {
  needsGesture: boolean;
  onUserGesture: () => void;
};

function Harness({
  live,
  liveGame,
  prefs,
  refOut,
}: {
  live: LiveGamePayload | null;
  liveGame: LiveGameEnvelope | null;
  prefs: VoicePrefs | null;
  refOut: HarnessRef;
}) {
  const v = useVoiceReadout(live, prefs, liveGame);
  useEffect(() => {
    refOut.needsGesture = v.needsGesture;
    refOut.onUserGesture = v.onUserGesture;
  });
  return null;
}

function envelope(extra: Partial<LiveGameEnvelope> = {}): LiveGameEnvelope {
  return {
    type: "liveGameState",
    phase: "match_loading",
    capturedAt: 0,
    gameKey: "k1",
    ...extra,
  };
}

describe("useVoiceReadout — live envelope path", () => {
  let cap: Capture;
  beforeEach(() => {
    clearSessionUnlock();
    cap = installSpeechSynthMock();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  function flush() {
    // Advance enough to cover the 900 ms MMR fallback PLUS the 300 ms
    // default speak delay, with margin — but well short of the 8 s
    // keep-alive interval that ``useVoiceReadout`` registers, so
    // ``runAllTimers`` doesn't loop into it forever. Tests that need
    // the longer 3 s enrichment fallback advance the clock explicitly
    // before calling ``flush``.
    act(() => {
      vi.advanceTimersByTime(2000);
    });
  }

  function flushEnrichmentFallback() {
    // Covers the 5 s enrichment fallback PLUS the 300 ms speak delay,
    // for tests that exercise the streamerHistory-never-arrives path.
    // Stays well under the 8 s keep-alive interval so ``runAllTimers``
    // doesn't loop forever.
    act(() => {
      vi.advanceTimersByTime(6000);
    });
  }

  it("speaks once per gameKey AFTER enrichment lands when partial arrives first", () => {
    // The broker's partial-then-enriched fan-out: a partial envelope
    // arrives without ``streamerHistory``, then ~50–300 ms later an
    // enriched re-emit carries the cloud's H2H + saved MMR. The hook
    // must hold the readout until enrichment lands so the streamer
    // hears the full sentence — name, race, MMR, H2H, "Good luck." —
    // and never the truncated partial version.
    window.localStorage.setItem("sc2tools.voiceUnlocked", "1");
    const ref: HarnessRef = { needsGesture: false, onUserGesture: () => {} };
    const partial = envelope({
      gameKey: "k1",
      opponent: { name: "Maru", race: "Terran" },
    });
    const enriched = envelope({
      gameKey: "k1",
      phase: "match_started",
      opponent: {
        name: "Maru",
        race: "Terran",
        profile: { mmr: 6720 },
      },
      streamerHistory: {
        oppName: "Maru",
        oppRace: "Terran",
        matchup: "PvT",
        headToHead: { wins: 3, losses: 1 },
      },
    });
    const { rerender } = render(
      <Harness
        live={null}
        liveGame={partial}
        prefs={{ enabled: true, events: { scouting: true } }}
        refOut={ref}
      />,
    );
    // Advance only a little — well short of the enrichment fallback
    // window so the partial-only line can't have fired yet.
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(cap.speak).not.toHaveBeenCalled();
    rerender(
      <Harness
        live={null}
        liveGame={enriched}
        prefs={{ enabled: true, events: { scouting: true } }}
        refOut={ref}
      />,
    );
    flush();
    expect(cap.speak).toHaveBeenCalledTimes(1);
    const text = cap.utterances[0]?.text || "";
    expect(text).toContain("Facing Maru, Terran.");
    expect(text).toContain("6720 MMR.");
    expect(text).toContain("You're 3 and 1 against them, 75 percent win rate.");
    expect(text).toContain("Good luck.");
  });

  it("waits for MMR before firing when streamerHistory lands first (Peruano repro)", () => {
    // 2026-05-11 stream repro: the cloud's enrichment landed quickly
    // (so ``streamerHistory.headToHead`` was set), but the agent's
    // Pulse profile lookup was still in flight, so
    // ``opponent.profile.mmr`` was missing. Pre-fix, the voice would
    // fire the moment ``streamerHistory`` was present and silently
    // drop the MMR clause. Now it waits for one of the two MMR
    // sources to land, and the visual card's "5564 MMR" actually
    // ends up in the spoken line.
    window.localStorage.setItem("sc2tools.voiceUnlocked", "1");
    const ref: HarnessRef = { needsGesture: false, onUserGesture: () => {} };
    const noMmrYet = envelope({
      gameKey: "peruano-1",
      opponent: { name: "Peruano", race: "Terran" }, // no profile yet
      streamerHistory: {
        oppName: "Peruano",
        oppRace: "Terran",
        matchup: "PvT",
        headToHead: { wins: 1, losses: 6 },
        // oppMmr also missing — neither MMR source ready yet.
      },
    });
    const withMmr = envelope({
      gameKey: "peruano-1",
      phase: "match_started",
      opponent: {
        name: "Peruano",
        race: "Terran",
        profile: { mmr: 5564 },
      },
      streamerHistory: {
        oppName: "Peruano",
        oppRace: "Terran",
        matchup: "PvT",
        headToHead: { wins: 1, losses: 6 },
      },
    });
    const { rerender } = render(
      <Harness
        live={null}
        liveGame={noMmrYet}
        prefs={{ enabled: true, events: { scouting: true } }}
        refOut={ref}
      />,
    );
    // streamerHistory is present but MMR is not — voice must NOT fire
    // yet. The 900 ms fallback timer is armed.
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(cap.speak).not.toHaveBeenCalled();
    // Pulse responds — envelope re-emitted with the MMR populated.
    rerender(
      <Harness
        live={null}
        liveGame={withMmr}
        prefs={{ enabled: true, events: { scouting: true } }}
        refOut={ref}
      />,
    );
    flush();
    expect(cap.speak).toHaveBeenCalledTimes(1);
    const text = cap.utterances[0]?.text || "";
    expect(text).toContain("5564 MMR.");
    expect(text).toContain("You're 1 and 6 against them, 14 percent win rate.");
    expect(text).toContain("Good luck.");
  });

  it("fires after 900 ms even when MMR never lands", () => {
    // Pulse outage + the opponents row never stamped a stored MMR.
    // After the full fallback window, the voice MUST fire with the
    // data it has rather than gagging indefinitely.
    window.localStorage.setItem("sc2tools.voiceUnlocked", "1");
    const ref: HarnessRef = { needsGesture: false, onUserGesture: () => {} };
    const env = envelope({
      gameKey: "no-mmr-1",
      opponent: { name: "Peruano", race: "Terran" },
      streamerHistory: {
        oppName: "Peruano",
        oppRace: "Terran",
        matchup: "PvT",
        headToHead: { wins: 1, losses: 6 },
      },
    });
    render(
      <Harness
        live={null}
        liveGame={env}
        prefs={{ enabled: true, events: { scouting: true } }}
        refOut={ref}
      />,
    );
    // 800 ms in — still waiting for MMR.
    act(() => {
      vi.advanceTimersByTime(800);
    });
    expect(cap.speak).not.toHaveBeenCalled();
    // Past 900 ms — fallback fires with the H2H but no MMR.
    flush();
    expect(cap.speak).toHaveBeenCalledTimes(1);
    const text = cap.utterances[0]?.text || "";
    expect(text).toContain("Facing Peruano, Terran.");
    expect(text).not.toMatch(/MMR/);
    expect(text).toContain("You're 1 and 6 against them, 14 percent win rate.");
    expect(text).toContain("Good luck.");
  });

  it("speaks the fallback line after the enrichment window when streamerHistory never arrives", () => {
    // Pulse outage / Mongo blip: the partial lands but no enriched
    // re-emit ever follows. The hook's enrichment fallback fires the
    // readout with whatever data is in hand rather than gagging the
    // streamer for the rest of the match. The window is the longer
    // ``ENRICHMENT_FALLBACK_WAIT_MS`` (5 s) because the cloud's
    // first-meeting opponents cold path (three-tier identity miss +
    // four sequential aggregations) realistically takes 1.8–2.5 s and
    // can exceed 3 s under load — we'd rather wait than silently drop
    // the H2H clause for a brand-new opponent.
    window.localStorage.setItem("sc2tools.voiceUnlocked", "1");
    const ref: HarnessRef = { needsGesture: false, onUserGesture: () => {} };
    const partial = envelope({
      gameKey: "outage-1",
      opponent: {
        name: "Cure",
        race: "Terran",
        profile: { mmr: 5400 },
      },
    });
    render(
      <Harness
        live={null}
        liveGame={partial}
        prefs={{ enabled: true, events: { scouting: true } }}
        refOut={ref}
      />,
    );
    // Just before the enrichment fallback window — must not have
    // spoken yet. (Note: the OLD 900 ms ceiling would have fired here,
    // dropping the H2H clause; the new 5 s window keeps the line
    // pending so a slow enrichment still gets a chance.)
    act(() => {
      vi.advanceTimersByTime(4800);
    });
    expect(cap.speak).not.toHaveBeenCalled();
    // After the enrichment fallback window — speech fires with the
    // partial data.
    flushEnrichmentFallback();
    expect(cap.speak).toHaveBeenCalledTimes(1);
    const text = cap.utterances[0]?.text || "";
    expect(text).toContain("Facing Cure, Terran.");
    expect(text).toContain("5400 MMR.");
    // No H2H clause because enrichment never landed.
    expect(text).not.toMatch(/against them/);
    expect(text).not.toMatch(/First meeting/);
    expect(text).toContain("Good luck.");
  });

  it("announces 'First meeting.' when enrichment is slow but eventually arrives with 0-0 H2H (first-meeting cold path)", () => {
    // 2026-05-12 stream repro: streamer's first match against a brand-
    // new opponent. Partial envelope arrives with the agent's Pulse-
    // resolved MMR right away, but the cloud's first-meeting Mongo
    // path (three-tier lookup → 0-0 stamp → recent-games / streak /
    // top-builds / meta aggregations) takes >1 s. Pre-fix the 900 ms
    // fallback fired first and the voice spoke "Facing X, Race. NNN
    // MMR. Good luck." with the "First meeting." clause silently
    // dropped — defeating the whole point of the cloud's explicit
    // 0-0 signal. Post-fix the longer enrichment window holds the
    // readout until streamerHistory lands.
    window.localStorage.setItem("sc2tools.voiceUnlocked", "1");
    const ref: HarnessRef = { needsGesture: false, onUserGesture: () => {} };
    const partial = envelope({
      gameKey: "cold-1",
      opponent: {
        name: "BrandNew",
        race: "Zerg",
        profile: { mmr: 4200 }, // MMR resolved fast
      },
      // streamerHistory absent — cloud aggregation still in flight.
    });
    const enriched = envelope({
      gameKey: "cold-1",
      phase: "match_started",
      opponent: {
        name: "BrandNew",
        race: "Zerg",
        profile: { mmr: 4200 },
      },
      streamerHistory: {
        oppName: "BrandNew",
        oppRace: "Zerg",
        matchup: "PvZ",
        headToHead: { wins: 0, losses: 0 },
      },
    });
    const { rerender } = render(
      <Harness
        live={null}
        liveGame={partial}
        prefs={{ enabled: true, events: { scouting: true } }}
        refOut={ref}
      />,
    );
    // Past the OLD 900 ms ceiling, well short of the new 3 s window.
    // Voice MUST NOT have spoken yet — silently dropping "First
    // meeting." is the regression we're fixing.
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(cap.speak).not.toHaveBeenCalled();
    // Cloud enrichment finally lands at ~2 s.
    rerender(
      <Harness
        live={null}
        liveGame={enriched}
        prefs={{ enabled: true, events: { scouting: true } }}
        refOut={ref}
      />,
    );
    flush();
    expect(cap.speak).toHaveBeenCalledTimes(1);
    const text = cap.utterances[0]?.text || "";
    expect(text).toContain("Facing BrandNew, Zerg.");
    expect(text).toContain("4200 MMR.");
    expect(text).toContain("First meeting.");
    expect(text).toContain("Good luck.");
  });

  it("says 'First meeting.' when streamerHistory.headToHead is 0-0", () => {
    // Cloud confirmed an empty record — the opponent is brand new.
    // The voice readout must announce "First meeting." rather than
    // omitting the H2H clause (which is the "enrichment hasn't
    // landed yet" signal).
    window.localStorage.setItem("sc2tools.voiceUnlocked", "1");
    const ref: HarnessRef = { needsGesture: false, onUserGesture: () => {} };
    const env = envelope({
      gameKey: "fresh-1",
      opponent: {
        name: "Stranger",
        race: "Zerg",
        profile: { mmr: 4200 },
      },
      streamerHistory: {
        oppName: "Stranger",
        oppRace: "Zerg",
        matchup: "PvZ",
        headToHead: { wins: 0, losses: 0 },
      },
    });
    render(
      <Harness
        live={null}
        liveGame={env}
        prefs={{ enabled: true, events: { scouting: true } }}
        refOut={ref}
      />,
    );
    flush();
    expect(cap.speak).toHaveBeenCalledTimes(1);
    const text = cap.utterances[0]?.text || "";
    expect(text).toContain("Facing Stranger, Zerg.");
    expect(text).toContain("4200 MMR.");
    expect(text).toContain("First meeting.");
    expect(text).toContain("Good luck.");
  });

  it("always ends the utterance with 'Good luck.'", () => {
    window.localStorage.setItem("sc2tools.voiceUnlocked", "1");
    const ref: HarnessRef = { needsGesture: false, onUserGesture: () => {} };
    const env = envelope({
      gameKey: "gl-1",
      opponent: { name: "Maru", race: "Terran" },
      streamerHistory: {
        oppName: "Maru",
        oppRace: "Terran",
        matchup: "PvT",
        headToHead: { wins: 5, losses: 2 },
      },
    });
    render(
      <Harness
        live={null}
        liveGame={env}
        prefs={{ enabled: true, events: { scouting: true } }}
        refOut={ref}
      />,
    );
    flush();
    expect(cap.speak).toHaveBeenCalledTimes(1);
    const text = cap.utterances[0]?.text || "";
    expect(text.trim().endsWith("Good luck.")).toBe(true);
  });

  it("does NOT speak again when an enriched envelope replaces a partial for the same gameKey AFTER the line already played", () => {
    // First the partial arrives → enrichment fallback fires → speech
    // plays (without the H2H clause). The broker's enriched re-emit
    // then lands for the SAME gameKey. The hook must not speak a
    // second time — duplicate utterance for one match is the original
    // bug.
    window.localStorage.setItem("sc2tools.voiceUnlocked", "1");
    const ref: HarnessRef = { needsGesture: false, onUserGesture: () => {} };
    const partial = envelope({
      gameKey: "dup-1",
      opponent: { name: "Reynor", race: "Zerg" },
    });
    const enriched = envelope({
      gameKey: "dup-1",
      phase: "match_started",
      opponent: {
        name: "Reynor",
        race: "Zerg",
        profile: { mmr: 6900 },
      },
      streamerHistory: {
        oppName: "Reynor",
        oppRace: "Zerg",
        matchup: "PvZ",
        headToHead: { wins: 1, losses: 4 },
      },
    });
    const { rerender } = render(
      <Harness
        live={null}
        liveGame={partial}
        prefs={{ enabled: true, events: { scouting: true } }}
        refOut={ref}
      />,
    );
    // Enrichment fallback fires — speech plays once with the partial.
    // (Neither streamerHistory nor MMR ever arrived before the timer,
    // so this is the worst-case 3 s wait.)
    flushEnrichmentFallback();
    expect(cap.speak).toHaveBeenCalledTimes(1);
    // Enriched re-emit for the same gameKey lands LATE.
    rerender(
      <Harness
        live={null}
        liveGame={enriched}
        prefs={{ enabled: true, events: { scouting: true } }}
        refOut={ref}
      />,
    );
    flush();
    // No second utterance — the per-gameKey state has spoken=true.
    expect(cap.speak).toHaveBeenCalledTimes(1);
  });

  it("does not re-speak when the envelope is re-emitted with Pulse profile (same gameKey)", () => {
    // The bridge fires twice for one match: a partial MATCH_LOADING
    // and the Pulse-enriched re-emit ~300 ms later. Both carry the
    // same gameKey — we must not speak twice.
    window.localStorage.setItem("sc2tools.voiceUnlocked", "1");
    const ref: HarnessRef = { needsGesture: false, onUserGesture: () => {} };
    const partial = envelope({
      gameKey: "k1",
      opponent: { name: "Maru", race: "Terran" },
      streamerHistory: {
        oppName: "Maru",
        oppRace: "Terran",
        matchup: "PvT",
        headToHead: { wins: 0, losses: 0 },
      },
    });
    const enriched = envelope({
      gameKey: "k1",
      phase: "match_started",
      opponent: {
        name: "Maru",
        race: "Terran",
        profile: { mmr: 6500, confidence: 1 },
      },
      streamerHistory: {
        oppName: "Maru",
        oppRace: "Terran",
        matchup: "PvT",
        headToHead: { wins: 0, losses: 0 },
      },
    });
    const { rerender } = render(
      <Harness
        live={null}
        liveGame={partial}
        prefs={{ enabled: true, events: { scouting: true } }}
        refOut={ref}
      />,
    );
    flush();
    rerender(
      <Harness
        live={null}
        liveGame={enriched}
        prefs={{ enabled: true, events: { scouting: true } }}
        refOut={ref}
      />,
    );
    flush();
    expect(cap.speak).toHaveBeenCalledTimes(1);
  });

  it("speaks twice across two distinct games (different gameKey)", () => {
    window.localStorage.setItem("sc2tools.voiceUnlocked", "1");
    const ref: HarnessRef = { needsGesture: false, onUserGesture: () => {} };
    const first = envelope({
      gameKey: "match-1",
      opponent: { name: "Cure", race: "Terran" },
      streamerHistory: {
        oppName: "Cure",
        oppRace: "Terran",
        matchup: "PvT",
        headToHead: { wins: 0, losses: 0 },
      },
    });
    const idle = envelope({ gameKey: undefined, phase: "idle" });
    const second = envelope({
      gameKey: "match-2",
      opponent: { name: "Reynor", race: "Zerg" },
      streamerHistory: {
        oppName: "Reynor",
        oppRace: "Zerg",
        matchup: "PvZ",
        headToHead: { wins: 0, losses: 0 },
      },
    });
    const { rerender } = render(
      <Harness
        live={null}
        liveGame={first}
        prefs={{ enabled: true, events: { scouting: true } }}
        refOut={ref}
      />,
    );
    flush();
    rerender(
      <Harness
        live={null}
        liveGame={idle}
        prefs={{ enabled: true, events: { scouting: true } }}
        refOut={ref}
      />,
    );
    flush();
    rerender(
      <Harness
        live={null}
        liveGame={second}
        prefs={{ enabled: true, events: { scouting: true } }}
        refOut={ref}
      />,
    );
    flush();
    expect(cap.speak).toHaveBeenCalledTimes(2);
    expect(cap.utterances[0]?.text).toContain("Cure");
    expect(cap.utterances[1]?.text).toContain("Reynor");
  });

  it("does NOT fire from the live envelope path when a post-game payload is set", () => {
    // The post-game ``live`` payload owns the readout in that scenario;
    // letting both fire would speak twice for the same match.
    window.localStorage.setItem("sc2tools.voiceUnlocked", "1");
    const ref: HarnessRef = { needsGesture: false, onUserGesture: () => {} };
    render(
      <Harness
        live={{ oppName: "Maru", oppRace: "Terran" }}
        liveGame={envelope({
          opponent: { name: "Maru", race: "Terran" },
          streamerHistory: {
            oppName: "Maru",
            oppRace: "Terran",
            matchup: "PvT",
            headToHead: { wins: 0, losses: 0 },
          },
        })}
        prefs={{ enabled: true, events: { scouting: true } }}
        refOut={ref}
      />,
    );
    flush();
    // Exactly one — the post-game ``buildScoutingLine`` path. The live
    // envelope path must not double-speak.
    expect(cap.speak).toHaveBeenCalledTimes(1);
  });

  it("respects events.scouting=false on the live envelope path", () => {
    window.localStorage.setItem("sc2tools.voiceUnlocked", "1");
    const ref: HarnessRef = { needsGesture: false, onUserGesture: () => {} };
    render(
      <Harness
        live={null}
        liveGame={envelope({
          opponent: { name: "Maru", race: "Terran" },
          streamerHistory: {
            oppName: "Maru",
            oppRace: "Terran",
            matchup: "PvT",
            headToHead: { wins: 0, losses: 0 },
          },
        })}
        prefs={{ enabled: true, events: { scouting: false } }}
        refOut={ref}
      />,
    );
    flush();
    expect(cap.speak).not.toHaveBeenCalled();
  });

  it("ignores envelopes with no opponent name", () => {
    window.localStorage.setItem("sc2tools.voiceUnlocked", "1");
    const ref: HarnessRef = { needsGesture: false, onUserGesture: () => {} };
    render(
      <Harness
        live={null}
        liveGame={envelope({ opponent: undefined })}
        prefs={{ enabled: true, events: { scouting: true } }}
        refOut={ref}
      />,
    );
    flush();
    expect(cap.speak).not.toHaveBeenCalled();
  });

  it("queues the live envelope readout when no gesture has been received yet", () => {
    const ref: HarnessRef = { needsGesture: false, onUserGesture: () => {} };
    const env = envelope({
      opponent: { name: "Maru", race: "Terran" },
      streamerHistory: {
        oppName: "Maru",
        oppRace: "Terran",
        matchup: "PvT",
        headToHead: { wins: 0, losses: 0 },
      },
    });
    render(
      <Harness
        live={null}
        liveGame={env}
        prefs={{ enabled: true, events: { scouting: true } }}
        refOut={ref}
      />,
    );
    flush();
    expect(cap.speak).not.toHaveBeenCalled();
    expect(ref.needsGesture).toBe(true);
    act(() => ref.onUserGesture());
    flush();
    expect(cap.speak).toHaveBeenCalledTimes(1);
    expect(cap.utterances[0]?.text).toContain("Facing Maru, Terran.");
  });
});
