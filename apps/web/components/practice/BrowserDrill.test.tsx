// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserDrill } from "./BrowserDrill";

const target = { v: 1 as const, name: "Opening", steps: [
  { t: 6, supply: 14, name: "Pylon" }, { t: 12, supply: null, name: "CyberneticsCore" },
] };

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Practice Link drill", () => {
  it("starts speech only after a gesture, speaks each due step once and resets", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
    const speak = vi.fn(), cancel = vi.fn();
    vi.stubGlobal("speechSynthesis", { speak, cancel, getVoices: () => [], addEventListener() {}, removeEventListener() {} });
    vi.stubGlobal("SpeechSynthesisUtterance", class { lang = ""; constructor(readonly text: string) {} });
    render(<BrowserDrill target={target} />);
    expect(speak).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Start drill" }));
    expect(speak).toHaveBeenCalledWith(expect.objectContaining({ text: "Drill started.", lang: "en-US" }));
    act(() => vi.advanceTimersByTime(1600));
    expect(speak).toHaveBeenCalledWith(expect.objectContaining({ text: "14 — Pylon" }));
    fireEvent.click(screen.getByRole("button", { name: "Forward one second" }));
    fireEvent.click(screen.getByRole("button", { name: "Back one second" }));
    expect(speak).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(cancel).toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(10_000));
    expect(speak).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(screen.getByLabelText("Drill time").textContent).toBe("0:00");
    expect(screen.getByRole("button", { name: "Start drill" })).toBeTruthy();
  });

  it("provides the visual drill without speech", () => {
    render(<BrowserDrill target={target} />);
    expect(screen.getByText(/Speech is unavailable/)).toBeTruthy();
    expect(screen.getByRole("list", { name: "Timed drill steps" }).textContent).toContain("Cybernetics Core");
  });

  it("speaks all steps that become due on the same tick in order", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
    const speak = vi.fn();
    vi.stubGlobal("speechSynthesis", { speak, cancel() {}, getVoices: () => [], addEventListener() {}, removeEventListener() {} });
    vi.stubGlobal("SpeechSynthesisUtterance", class { lang = ""; constructor(readonly text: string) {} });
    const steps = [target.steps[0], { t: 6, supply: 15, name: "Gateway" }, target.steps[1]];
    render(<BrowserDrill target={{ ...target, steps }} />);
    fireEvent.click(screen.getByRole("button", { name: "Start drill" }));
    act(() => vi.advanceTimersByTime(1600));
    expect(speak.mock.calls.map(([utterance]) => utterance.text)).toEqual(["Drill started.", "14 — Pylon", "15 — Gateway"]);
  });

  it("releases an acquired wake lock on pause", async () => {
    const original = Object.getOwnPropertyDescriptor(navigator, "wakeLock");
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const release = vi.fn(async () => {});
    const lock = Object.assign(new EventTarget(), { released: false, release });
    const request = vi.fn(async () => lock);
    Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request } });
    try {
      render(<BrowserDrill target={target} />);
      expect(request).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Start drill" }));
      await waitFor(() => expect(request).toHaveBeenCalledWith("screen"));
      await screen.findByText("Keeping this screen awake while visible.");
      fireEvent.click(screen.getByRole("button", { name: "Pause" }));
      expect(release).toHaveBeenCalledTimes(1);
    } finally {
      visibility.mockRestore();
      if (original) Object.defineProperty(navigator, "wakeLock", original);
      else Reflect.deleteProperty(navigator, "wakeLock");
    }
  });
});
