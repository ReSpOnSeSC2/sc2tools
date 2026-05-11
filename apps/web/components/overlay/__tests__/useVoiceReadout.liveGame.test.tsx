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
import {
  useVoiceReadout,
  type VoicePrefs,
  buildLiveGameScoutingLine,
} from "../useVoiceReadout";
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
    act(() => {
      vi.runOnlyPendingTimers();
    });
  }

  it("speaks once per gameKey when the agent's MATCH_LOADING envelope arrives", () => {
    window.localStorage.setItem("sc2tools.voiceUnlocked", "1");
    const ref: HarnessRef = { needsGesture: false, onUserGesture: () => {} };
    const env = envelope({
      phase: "match_loading",
      opponent: { name: "Maru", race: "Terran" },
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
    expect(cap.utterances[0]?.text).toContain("Facing Maru, Terran.");
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
    });
    const enriched = envelope({
      gameKey: "k1",
      phase: "match_started",
      opponent: {
        name: "Maru",
        race: "Terran",
        profile: { mmr: 6500, confidence: 1 },
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
    });
    const idle = envelope({ gameKey: undefined, phase: "idle" });
    const second = envelope({
      gameKey: "match-2",
      opponent: { name: "Reynor", race: "Zerg" },
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
        liveGame={envelope({ opponent: { name: "Maru", race: "Terran" } })}
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

describe("buildLiveGameScoutingLine", () => {
  it("speaks name + race when both are set", () => {
    expect(
      buildLiveGameScoutingLine({
        type: "liveGameState",
        phase: "match_loading",
        capturedAt: 0,
        opponent: { name: "Serral", race: "Zerg" },
      }),
    ).toContain("Facing Serral, Zerg.");
  });

  it("appends MMR when the bridge's profile carries it", () => {
    expect(
      buildLiveGameScoutingLine({
        type: "liveGameState",
        phase: "match_loading",
        capturedAt: 0,
        opponent: {
          name: "Serral",
          race: "Zerg",
          profile: { mmr: 7100 },
        },
      }),
    ).toContain("7100 MMR.");
  });

  it("falls back to 'unknown opponent' when neither name nor race is set", () => {
    expect(
      buildLiveGameScoutingLine({
        type: "liveGameState",
        phase: "match_loading",
        capturedAt: 0,
      }),
    ).toContain("Facing an unknown opponent.");
  });

  it("announces head-to-head record and win percentage when streamerHistory carries them", () => {
    // Mirrors the THEBLOB-style case: pre-game card has the cloud's
    // enrichment attached. The voice line must include the record
    // (the agent's match-loading utterance previously read only the
    // name) and the win % the streamer asked for at match start.
    const out = buildLiveGameScoutingLine({
      type: "liveGameState",
      phase: "match_loading",
      capturedAt: 0,
      opponent: { name: "THEBLOB", race: "Protoss" },
      streamerHistory: {
        oppName: "THEBLOB",
        oppRace: "Protoss",
        matchup: "PvP",
        headToHead: { wins: 3, losses: 1 },
      },
    });
    expect(out).toContain("Facing THEBLOB, Protoss.");
    // 3 + 1 = 4; 3/4 = 75% win rate.
    expect(out).toContain("You're 3 and 1 against them, 75 percent win rate.");
  });

  it("says 'First meeting.' when streamerHistory confirms an empty record", () => {
    const out = buildLiveGameScoutingLine({
      type: "liveGameState",
      phase: "match_loading",
      capturedAt: 0,
      opponent: { name: "FreshAccount", race: "Terran" },
      streamerHistory: {
        oppName: "FreshAccount",
        oppRace: "Terran",
        matchup: "PvT",
        headToHead: { wins: 0, losses: 0 },
      },
    });
    expect(out).toContain("First meeting.");
    expect(out).not.toMatch(/percent win rate/);
  });

  it("stays silent on H2H when streamerHistory has not landed yet (no false 'first meeting')", () => {
    // Envelope arrived before the cloud's enrichment hook ran — we
    // can't tell whether this is a first meeting or a repeat
    // opponent, so the utterance must omit the H2H clause rather
    // than claim "first meeting" and risk lying.
    const out = buildLiveGameScoutingLine({
      type: "liveGameState",
      phase: "match_loading",
      capturedAt: 0,
      opponent: { name: "Maybe", race: "Zerg" },
    });
    expect(out).not.toMatch(/First meeting/);
    expect(out).not.toMatch(/against them/);
  });

  it("prefers SC2Pulse's current MMR over the cloud's saved last-game MMR", () => {
    // Pulse is the authoritative "current season rating" source —
    // when it has a value the spoken line uses it, even if the
    // cloud's opponents row carries an older saved value from the
    // last encounter.
    const out = buildLiveGameScoutingLine({
      type: "liveGameState",
      phase: "match_loading",
      capturedAt: 0,
      opponent: {
        name: "THEBLOB",
        race: "Protoss",
        profile: { mmr: 4480 }, // current Pulse rating
      },
      streamerHistory: {
        oppName: "THEBLOB",
        oppRace: "Protoss",
        matchup: "PvP",
        oppMmr: 4327, // saved at end of last game
        headToHead: { wins: 3, losses: 1 },
      },
    });
    expect(out).toContain("4480 MMR.");
    expect(out).not.toContain("4327 MMR.");
  });

  it("falls back to the saved last-game MMR when Pulse has no usable rating", () => {
    // THEBLOB-style case: Pulse returned a profile but no MMR
    // (insufficient season games / off-ladder activity). The voice
    // line should still announce the saved last-game MMR rather
    // than going silent on the MMR slot.
    const out = buildLiveGameScoutingLine({
      type: "liveGameState",
      phase: "match_loading",
      capturedAt: 0,
      opponent: {
        name: "THEBLOB",
        race: "Protoss",
        profile: { mmr: 0 }, // Pulse returned nothing usable
      },
      streamerHistory: {
        oppName: "THEBLOB",
        oppRace: "Protoss",
        matchup: "PvP",
        oppMmr: 4327,
        headToHead: { wins: 3, losses: 1 },
      },
    });
    expect(out).toContain("4327 MMR.");
  });
});
