import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import { SettingsVoice } from "./SettingsVoice";

/* ------------------------------------------------------------------
 * Mocks for the SettingsVoice dependencies. The component pulls in:
 *   - useApi from clientApi (we return a static prefs blob).
 *   - useAuth + apiCall (we no-op on save — tests cover preview).
 *   - useToast (we capture toast calls so the unlock banner test can
 *     verify the autoplay-block path does NOT toast).
 *   - SettingsContext usePublishDirty (no-op).
 * ------------------------------------------------------------------ */

const mockToast = {
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
};

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: async () => "tok" }),
}));

vi.mock("@/lib/clientApi", () => ({
  apiCall: vi.fn(async () => ({})),
  useApi: () => ({
    data: {
      enabled: true,
      voice: "",
      rate: 1,
      pitch: 1,
      volume: 1,
      delayMs: 0,
      events: { scouting: true },
    },
    isLoading: false,
    mutate: vi.fn(),
  }),
}));

vi.mock("@/components/ui/Toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

vi.mock("./SettingsContext", () => ({
  usePublishDirty: () => undefined,
}));

vi.mock("@/components/ui/Card", () => ({
  Card: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Skeleton: () => <div>loading</div>,
}));

vi.mock("@/components/ui/Section", () => ({
  Section: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
}));

vi.mock("@/components/ui/Field", () => ({
  Field: ({ label, children }: { label: React.ReactNode; children: React.ReactNode }) => (
    <label>{label}{children}</label>
  ),
}));

vi.mock("@/components/ui/Select", () => ({
  Select: ({ children, ...props }: { children: React.ReactNode } & React.HTMLProps<HTMLSelectElement>) => (
    <select {...props}>{children}</select>
  ),
}));

vi.mock("@/components/ui/Toggle", () => ({
  Toggle: ({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) => (
    <input
      type="checkbox"
      aria-label={label}
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
    />
  ),
}));

vi.mock("@/components/ui/Button", () => ({
  Button: ({ children, onClick, iconLeft }: { children: React.ReactNode; onClick: () => void; iconLeft?: React.ReactNode }) => (
    <button type="button" onClick={onClick}>
      {iconLeft}
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/SaveBar", () => ({
  SaveBar: () => null,
}));

vi.mock("@/components/ui/useDirtyForm", () => ({
  useDirtyForm: <T,>(data: T, defaults: T) => {
    const draft = data ?? defaults;
    return {
      draft,
      setDraft: vi.fn(),
      dirty: false,
      reset: vi.fn(),
      markSaved: vi.fn(),
    };
  },
}));

vi.mock("lucide-react", () => ({
  Volume2: () => <span>volume</span>,
  Play: () => <span>play</span>,
  Square: () => <span>square</span>,
}));

/* ------------------------------------------------------------------
 * Web Speech API mock — captures every utterance + lets each test
 * decide whether to fire onstart, onend, or onerror.
 * ------------------------------------------------------------------ */

type SpeechMockState = {
  utterances: SpeechSynthesisUtterance[];
  speak: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
};

function installSpeechSynthMock(): SpeechMockState {
  const utterances: SpeechSynthesisUtterance[] = [];
  const speak = vi.fn((u: SpeechSynthesisUtterance) => {
    utterances.push(u);
  });
  const cancel = vi.fn();
  Object.defineProperty(window, "speechSynthesis", {
    value: {
      speak,
      cancel,
      getVoices: () => [],
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as SpeechSynthesis,
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
      onstart: ((ev: Event) => void) | null = null;
      onend: ((ev: Event) => void) | null = null;
      onerror: ((ev: Event) => void) | null = null;
      constructor(text: string) {
        this.text = text;
      }
    }
    (window as unknown as { SpeechSynthesisUtterance: typeof FakeUtt })
      .SpeechSynthesisUtterance = FakeUtt;
  }
  return { utterances, speak, cancel };
}

describe("<SettingsVoice />", () => {
  let speech: SpeechMockState;

  beforeEach(() => {
    mockToast.success.mockReset();
    mockToast.error.mockReset();
    mockToast.warning.mockReset();
    speech = installSpeechSynthMock();
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("Test voice button calls speechSynthesis.speak with a phrase matching the live readout shape", () => {
    // The preview phrase must mirror what ``buildLiveGameScoutingLine``
    // produces at match start so the streamer hears in Settings exactly
    // what they'll hear in OBS: name, race, MMR, H2H with win-%, and a
    // trailing "Good luck."
    render(<SettingsVoice />);
    const btn = screen.getByRole("button", { name: /test voice/i });
    act(() => {
      fireEvent.click(btn);
    });
    expect(speech.speak).toHaveBeenCalledTimes(1);
    const text = speech.utterances[0].text;
    expect(text).toMatch(/Facing \w+, (Terran|Zerg|Protoss)\./);
    expect(text).toMatch(/\d+ MMR\./);
    expect(text).toMatch(/You're \d+ and \d+ against them, \d+ percent win rate\./);
    expect(text.trim().endsWith("Good luck.")).toBe(true);
  });

  it("shows the autoplay-blocked banner when speak fires onerror with not-allowed", () => {
    render(<SettingsVoice />);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /test voice/i }));
    });
    // Trigger the not-allowed error path.
    const utt = speech.utterances[0];
    act(() => {
      utt.onerror?.({ error: "not-allowed" } as unknown as Event);
    });
    expect(screen.getByRole("alert").textContent).toMatch(/voice blocked by your browser/i);
    // The error path must NOT toast for autoplay block — the banner
    // is the canonical UX so a popping toast would be redundant.
    expect(mockToast.error).not.toHaveBeenCalled();
  });

  it("shows the banner when the engine silently drops the utterance (no onstart in 2s)", () => {
    render(<SettingsVoice />);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /test voice/i }));
    });
    // Advance 2 s without firing onstart — the silent-failure timer
    // should mark autoplay blocked.
    act(() => {
      vi.advanceTimersByTime(2100);
    });
    expect(screen.getByRole("alert").textContent).toMatch(/voice blocked/i);
  });

  it("does not show the banner when onstart fires before the silent-failure threshold", () => {
    render(<SettingsVoice />);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /test voice/i }));
    });
    const utt = speech.utterances[0];
    act(() => {
      utt.onstart?.({} as Event);
    });
    act(() => {
      vi.advanceTimersByTime(2500);
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("toasts a generic error for non-autoplay failures (e.g. synthesis-failed)", () => {
    render(<SettingsVoice />);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /test voice/i }));
    });
    act(() => {
      speech.utterances[0].onerror?.({ error: "synthesis-failed" } as unknown as Event);
    });
    expect(mockToast.error).toHaveBeenCalledWith(
      "Voice preview failed",
      expect.objectContaining({ description: "synthesis-failed" }),
    );
    // Banner stays hidden — not an autoplay issue.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("ignores benign cancellations (interrupted/canceled)", () => {
    render(<SettingsVoice />);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /test voice/i }));
    });
    act(() => {
      speech.utterances[0].onerror?.({ error: "interrupted" } as unknown as Event);
    });
    expect(mockToast.error).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
