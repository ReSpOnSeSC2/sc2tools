import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

/**
 * Verifies the all-in-one ``/overlay/<token>`` URL now wires the
 * agent's pre-game envelope into the voice readout — the second
 * failure point the spec called out (the per-widget URL already did,
 * but the all-in-one client was missing the ``overlay:liveGame``
 * handler and the third arg to ``useVoiceReadout``).
 *
 * Strategy: stub ``socket.io-client`` so we can fire an
 * ``overlay:liveGame`` event directly, stub the Web Speech surface so
 * we can capture the utterance, and assert that the readout fires
 * with the spec-shaped sentence (including "Good luck.").
 */

type SocketHandler = (...args: unknown[]) => void;

class FakeSocket {
  handlers = new Map<string, SocketHandler>();
  emitted: Array<{ event: string; payload?: unknown }> = [];
  disconnected = false;

  on(event: string, handler: SocketHandler) {
    this.handlers.set(event, handler);
  }

  emit(event: string, payload?: unknown) {
    this.emitted.push({ event, payload });
  }

  disconnect() {
    this.disconnected = true;
  }

  fire(event: string, ...args: unknown[]) {
    const fn = this.handlers.get(event);
    if (fn) fn(...args);
  }
}

let activeSocket: FakeSocket | null = null;

vi.mock("socket.io-client", () => ({
  io: () => {
    const s = new FakeSocket();
    activeSocket = s;
    return s;
  },
}));

vi.mock("@/lib/clientApi", () => ({
  API_BASE: "http://test.invalid",
}));

vi.mock("@/lib/timeseries", () => ({
  clientTimezone: () => "UTC",
}));

type Capture = {
  speak: ReturnType<typeof vi.fn>;
  utterances: SpeechSynthesisUtterance[];
};

function installSpeechSynthMock(): Capture {
  const utterances: SpeechSynthesisUtterance[] = [];
  const speak = vi.fn((u: SpeechSynthesisUtterance) => {
    utterances.push(u);
  });
  const fakeSynth = {
    speak,
    cancel: vi.fn(),
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
  return { speak, utterances };
}

import { OverlayClient } from "../OverlayClient";

describe("OverlayClient — voice readout on the all-in-one URL", () => {
  let cap: Capture;
  beforeEach(() => {
    activeSocket = null;
    cap = installSpeechSynthMock();
    vi.useFakeTimers();
    try {
      // Pre-grant the gesture unlock so the test doesn't have to drive
      // a banner click — we're isolating the envelope→speech wiring.
      window.localStorage.setItem("sc2tools.voiceUnlocked", "1");
    } catch {
      /* ignore */
    }
  });

  afterEach(() => {
    cleanup();
    try {
      window.localStorage.removeItem("sc2tools.voiceUnlocked");
    } catch {
      /* ignore */
    }
    vi.useRealTimers();
  });

  it("speaks the spec-shaped scouting line when an enriched liveGame envelope arrives", () => {
    render(<OverlayClient token="tok-1" />);
    expect(activeSocket).not.toBeNull();
    const socket = activeSocket as FakeSocket;

    // Voice prefs land first so the hook treats voice as enabled.
    act(() => {
      socket.fire("overlay:config", {
        enabledWidgets: ["scouting"],
        voicePrefs: { enabled: true, events: { scouting: true }, delayMs: 0 },
      });
    });

    // Enriched envelope: name, race, Pulse MMR, and the cloud's
    // streamerHistory.headToHead populated.
    act(() => {
      socket.fire("overlay:liveGame", {
        type: "liveGameState",
        phase: "match_loading",
        capturedAt: 1,
        gameKey: "key-1",
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
    });

    // Flush the hook's delay timer so synth.speak actually fires.
    // 2 s covers the 900 ms enrichment fallback + 300 ms speak delay
    // chain with margin, while staying short of the hook's 8 s keep-
    // alive interval so the fake-timer loop terminates cleanly.
    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(cap.speak).toHaveBeenCalledTimes(1);
    const text = cap.utterances[0]?.text || "";
    expect(text).toContain("Facing Maru, Terran.");
    expect(text).toContain("6720 MMR.");
    expect(text).toContain("You're 3 and 1 against them, 75 percent win rate.");
    expect(text.trim().endsWith("Good luck.")).toBe(true);
  });

  it("speaks 'First meeting.' when the cloud confirms a zero-zero record", () => {
    render(<OverlayClient token="tok-1" />);
    const socket = activeSocket as FakeSocket;
    act(() => {
      socket.fire("overlay:config", {
        enabledWidgets: ["scouting"],
        voicePrefs: { enabled: true, events: { scouting: true }, delayMs: 0 },
      });
    });
    act(() => {
      socket.fire("overlay:liveGame", {
        type: "liveGameState",
        phase: "match_loading",
        capturedAt: 1,
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
    });
    // 2 s covers the 900 ms enrichment fallback + 300 ms speak delay
    // chain with margin, while staying short of the hook's 8 s keep-
    // alive interval so the fake-timer loop terminates cleanly.
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(cap.speak).toHaveBeenCalledTimes(1);
    const text = cap.utterances[0]?.text || "";
    expect(text).toContain("First meeting.");
    expect(text).toContain("Good luck.");
  });
});
