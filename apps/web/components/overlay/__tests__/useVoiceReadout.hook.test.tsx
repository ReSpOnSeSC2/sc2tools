import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { useEffect } from "react";
import { useVoiceReadout, type VoicePrefs } from "../useVoiceReadout";
import type { LiveGamePayload } from "../types";

/* ------------------------------------------------------------------
 * Web Speech mock — captures every utterance .speak() receives so the
 * tests can assert "exactly one readout" and "cancelled on opponent
 * change" without touching the real browser engine.
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
  // jsdom omits SpeechSynthesisUtterance — provide a minimal stand-in.
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
  // The hook persists the gesture unlock in localStorage primary
  // (so OBS Browser Source refreshes don't re-prompt), with sessionStorage
  // as a fallback. Clear both so a previous test's gesture grant doesn't
  // bleed into the next test's "no gesture yet" precondition.
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

/* ------------------------------------------------------------------
 * Test harness — a tiny component that exposes `onUserGesture` so
 * the test can drive the unlock flow programmatically. We can't use
 * @testing-library/react's renderHook for the gesture-replay path
 * because we need to capture the hook's surface alongside re-renders
 * driven by changing props.
 * ------------------------------------------------------------------ */
type HarnessRef = {
  needsGesture: boolean;
  onUserGesture: () => void;
};

function Harness({
  live,
  prefs,
  refOut,
}: {
  live: LiveGamePayload | null;
  prefs: VoicePrefs | null;
  refOut: HarnessRef;
}) {
  const v = useVoiceReadout(live, prefs);
  // Mutate by reference so the test reads the latest snapshot.
  useEffect(() => {
    refOut.needsGesture = v.needsGesture;
    refOut.onUserGesture = v.onUserGesture;
  });
  return null;
}

describe("useVoiceReadout (hook)", () => {
  let cap: Capture;
  beforeEach(() => {
    clearSessionUnlock();
    cap = installSpeechSynthMock();
    // Fast-forward ``setTimeout`` so the hook's pre-utterance delay
    // doesn't slow tests. Vi's fake timers cover both setTimeout and
    // setInterval used by the keep-alive resume() trick.
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

  it("speaks once when a scouting payload arrives (after gesture)", () => {
    const ref: HarnessRef = { needsGesture: false, onUserGesture: () => {} };
    const live: LiveGamePayload = {
      oppName: "Alice",
      oppRace: "Zerg",
      headToHead: { wins: 2, losses: 1 },
    };
    const { rerender } = render(
      <Harness
        live={null}
        prefs={{ enabled: true, events: { scouting: true } }}
        refOut={ref}
      />,
    );
    rerender(
      <Harness
        live={live}
        prefs={{ enabled: true, events: { scouting: true } }}
        refOut={ref}
      />,
    );
    // First payload arrives before any gesture — must queue.
    expect(cap.speak).not.toHaveBeenCalled();
    expect(ref.needsGesture).toBe(true);
    act(() => ref.onUserGesture());
    flush();
    expect(cap.speak).toHaveBeenCalledTimes(1);
    const text = cap.utterances[0]?.text || "";
    expect(text).toContain("Facing Alice, Zerg.");
    // Post-game ``buildScoutingLine`` now mirrors the live builder —
    // H2H carries the win-% clause and the line ends with "Good luck."
    expect(text).toContain("You're 2 and 1 against them, 67 percent win rate.");
    expect(text.trim().endsWith("Good luck.")).toBe(true);
  });

  it("does not re-speak the same opponent on duplicate payload", () => {
    const ref: HarnessRef = { needsGesture: false, onUserGesture: () => {} };
    // Pre-grant gesture so we don't have to drive the click.
    window.sessionStorage.setItem("sc2tools.voiceUnlocked", "1");
    const live: LiveGamePayload = {
      oppName: "Alice",
      oppRace: "Zerg",
      headToHead: { wins: 2, losses: 1 },
    };
    const prefs = { enabled: true, events: { scouting: true } };
    const { rerender } = render(
      <Harness live={live} prefs={prefs} refOut={ref} />,
    );
    flush();
    rerender(<Harness live={{ ...live }} prefs={prefs} refOut={ref} />);
    flush();
    expect(cap.speak).toHaveBeenCalledTimes(1);
  });

  it("does NOT cancel in-flight scouting line when sync payload (result set) lands with a different opponent", () => {
    // Reproduces the 13k-replay-backfill bug: while a Test scouting line
    // is mid-sentence, the cloud emits one overlay:live per accepted
    // game during ingest. Each carries a different oppName AND result.
    // The previous code cancelled speech whenever oppName changed,
    // regardless of result, so the streamer heard half a sentence
    // before the next sync batch silenced it.
    const ref: HarnessRef = { needsGesture: false, onUserGesture: () => {} };
    window.localStorage.setItem("sc2tools.voiceUnlocked", "1");
    const prefs = { enabled: true, events: { scouting: true } };
    const { rerender } = render(
      <Harness
        live={{ oppName: "TestUser", oppRace: "Protoss" }}
        prefs={prefs}
        refOut={ref}
      />,
    );
    flush();
    expect(cap.speak).toHaveBeenCalledTimes(1);
    cap.cancel.mockClear();
    // Sync batch arrives with a different opponent AND a result. Must
    // NOT cancel the in-flight scouting line.
    rerender(
      <Harness
        live={{
          oppName: "scarlett",
          oppRace: "Protoss",
          result: "loss",
        }}
        prefs={prefs}
        refOut={ref}
      />,
    );
    flush();
    expect(cap.cancel).not.toHaveBeenCalled();
    // Same again — N sync batches in a row, none of them should
    // interrupt.
    rerender(
      <Harness
        live={{
          oppName: "serral",
          oppRace: "Zerg",
          result: "win",
        }}
        prefs={prefs}
        refOut={ref}
      />,
    );
    flush();
    expect(cap.cancel).not.toHaveBeenCalled();
    // No new utterance fired either — scouting line gated on !result,
    // matchEnd off by default, cheese off by default.
    expect(cap.speak).toHaveBeenCalledTimes(1);
  });

  it("cancels in-flight utterance when opponent changes mid-readout", () => {
    const ref: HarnessRef = { needsGesture: false, onUserGesture: () => {} };
    window.sessionStorage.setItem("sc2tools.voiceUnlocked", "1");
    const prefs = { enabled: true, events: { scouting: true } };
    const { rerender } = render(
      <Harness
        live={{ oppName: "Alice", oppRace: "Zerg" }}
        prefs={prefs}
        refOut={ref}
      />,
    );
    flush();
    expect(cap.speak).toHaveBeenCalledTimes(1);
    rerender(
      <Harness
        live={{ oppName: "Bob", oppRace: "Terran" }}
        prefs={prefs}
        refOut={ref}
      />,
    );
    flush();
    expect(cap.cancel).toHaveBeenCalled();
    expect(cap.speak).toHaveBeenCalledTimes(2);
    expect(cap.utterances[1]?.text).toContain("Facing Bob, Terran.");
  });

  it("respects enabled=false and never speaks", () => {
    const ref: HarnessRef = { needsGesture: false, onUserGesture: () => {} };
    window.sessionStorage.setItem("sc2tools.voiceUnlocked", "1");
    render(
      <Harness
        live={{ oppName: "Alice", oppRace: "Zerg" }}
        prefs={{ enabled: false, events: { scouting: true } }}
        refOut={ref}
      />,
    );
    flush();
    expect(cap.speak).not.toHaveBeenCalled();
    expect(ref.needsGesture).toBe(false);
  });

  it("respects events.scouting=false and never speaks scouting line", () => {
    const ref: HarnessRef = { needsGesture: false, onUserGesture: () => {} };
    window.sessionStorage.setItem("sc2tools.voiceUnlocked", "1");
    render(
      <Harness
        live={{ oppName: "Alice", oppRace: "Zerg" }}
        prefs={{ enabled: true, events: { scouting: false } }}
        refOut={ref}
      />,
    );
    flush();
    expect(cap.speak).not.toHaveBeenCalled();
  });

  it("needsGesture is true as soon as voice is enabled, even before any payload", () => {
    // Per-widget OBS Browser Source for scouting opens the URL with no
    // active payload. The streamer needs the gesture banner to appear
    // immediately so they can click it during OBS setup — before the
    // first scouting line fires inside the 22s visibility window.
    const ref: HarnessRef = { needsGesture: false, onUserGesture: () => {} };
    render(
      <Harness
        live={null}
        prefs={{ enabled: true, events: { scouting: true } }}
        refOut={ref}
      />,
    );
    expect(ref.needsGesture).toBe(true);
    expect(cap.speak).not.toHaveBeenCalled();
  });

  it("document-wide click grants the gesture (mirrors legacy SPA UX)", () => {
    const ref: HarnessRef = { needsGesture: false, onUserGesture: () => {} };
    const live: LiveGamePayload = {
      oppName: "Alice",
      oppRace: "Zerg",
      headToHead: { wins: 2, losses: 1 },
    };
    render(
      <Harness
        live={live}
        prefs={{ enabled: true, events: { scouting: true } }}
        refOut={ref}
      />,
    );
    flush();
    expect(cap.speak).not.toHaveBeenCalled();
    // ANY click on the document — not just the banner — should unlock
    // speech. Streamers don't have to find the small banner element.
    act(() => {
      document.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    flush();
    expect(cap.speak).toHaveBeenCalledTimes(1);
    expect(cap.utterances[0]?.text).toContain("Facing Alice, Zerg.");
  });

  it("persists the unlock in localStorage so OBS Browser Source refreshes don't re-prompt", () => {
    const ref: HarnessRef = { needsGesture: false, onUserGesture: () => {} };
    const prefs = { enabled: true, events: { scouting: true } };
    const { unmount } = render(
      <Harness
        live={{ oppName: "Alice", oppRace: "Zerg" }}
        prefs={prefs}
        refOut={ref}
      />,
    );
    act(() => ref.onUserGesture());
    flush();
    // OBS reload simulated: tear down, then mount a fresh hook with no
    // pre-set sessionStorage entry. localStorage must survive — that's
    // the whole point of switching the primary store.
    unmount();
    expect(window.localStorage.getItem("sc2tools.voiceUnlocked")).toBe("1");
    cap.speak.mockClear();
    const ref2: HarnessRef = { needsGesture: false, onUserGesture: () => {} };
    render(
      <Harness
        live={{ oppName: "Bob", oppRace: "Terran" }}
        prefs={prefs}
        refOut={ref2}
      />,
    );
    flush();
    expect(ref2.needsGesture).toBe(false);
    expect(cap.speak).toHaveBeenCalledTimes(1);
    expect(cap.utterances[cap.utterances.length - 1]?.text).toContain(
      "Facing Bob",
    );
  });

  it("queues until gesture, then replays the most recent payload", () => {
    const ref: HarnessRef = { needsGesture: false, onUserGesture: () => {} };
    const prefs = { enabled: true, events: { scouting: true } };
    const { rerender } = render(
      <Harness
        live={{ oppName: "Alice", oppRace: "Zerg" }}
        prefs={prefs}
        refOut={ref}
      />,
    );
    flush();
    expect(cap.speak).not.toHaveBeenCalled();
    expect(ref.needsGesture).toBe(true);
    // Second payload arrives while still queued — gesture replay
    // should speak THIS one, not the first.
    rerender(
      <Harness
        live={{ oppName: "Bob", oppRace: "Terran" }}
        prefs={prefs}
        refOut={ref}
      />,
    );
    flush();
    expect(cap.speak).not.toHaveBeenCalled();
    act(() => ref.onUserGesture());
    flush();
    expect(cap.speak).toHaveBeenCalledTimes(1);
    expect(cap.utterances[0]?.text).toContain("Facing Bob");
  });
});
