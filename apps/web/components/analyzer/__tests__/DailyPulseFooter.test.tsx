import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { IDBFactory } from "fake-indexeddb";
import type { AnalysisGamesResult } from "@/components/analyzer/arcade/hooks/useAnalysisGames";
import { noteDeviceCopy } from "@/lib/analysisCorpus/deviceNote";
import { DailyPulseFooter } from "../DailyPulseFooter";

const NOW = 1_793_000_000_000;

function games(overrides: Partial<AnalysisGamesResult> = {}): AnalysisGamesResult {
  return {
    items: ["g1", "g2", "g3"].map((gameId) => ({ gameId, date: "2026-10-31T09:00:00.000Z", result: "Victory" })),
    isLoading: false,
    error: null,
    pagesFetched: 1,
    hitCorpusLimit: false,
    onDevice: false,
    syncedAt: NOW - 5 * 60_000,
    isActive: true,
    load: vi.fn(),
    keepOnDevice: vi.fn(),
    release: vi.fn(),
    ...overrides,
  };
}

function footer(result: AnalysisGamesResult) {
  return render(<DailyPulseFooter games={result} accountKey="user-a" />);
}

const keepButton = () => screen.queryByRole("button", { name: "Keep on this device" });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(NOW);
  vi.stubGlobal("indexedDB", new IDBFactory());
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("DailyPulseFooter", () => {
  it("says when the history last updated and how many games this device keeps, and keeps the time true", () => {
    noteDeviceCopy("user-a");
    const result = games({ onDevice: true });
    footer(result);

    expect(screen.getByRole("status").textContent).toBe("Updated");
    expect(screen.getByRole("status").parentElement?.textContent).toBe("Updated 5m ago");
    expect(screen.getByText("3 games on this device")).toBeTruthy();
    expect(keepButton()).toBeNull();

    act(() => vi.advanceTimersByTime(55 * 60_000));
    expect(screen.getByRole("status").parentElement?.textContent).toBe("Updated 1h ago");
    act(() => vi.advanceTimersByTime(24 * 60 * 60_000));
    expect(screen.getByRole("status").parentElement?.textContent).toBe("Updated 1d ago");

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(result.load).toHaveBeenCalledTimes(1);
  });

  it("says just now for a fresh update and counts a single game", () => {
    noteDeviceCopy("user-a");
    footer(games({ syncedAt: NOW, items: [{ gameId: "g1", date: "2026-10-31T09:00:00.000Z", result: "Victory" }] }));
    expect(screen.getByRole("status").parentElement?.textContent).toBe("Updated just now");
    expect(screen.getByText("1 game")).toBeTruthy();
  });

  it("holds Refresh and offers nothing else while the history updates", () => {
    footer(games({ syncedAt: null }));
    expect(screen.getByRole("status").parentElement?.textContent).toBe("Updating…");
    expect(screen.getByRole("button", { name: "Refresh" }).hasAttribute("disabled")).toBe(true);
    expect(keepButton()).toBeNull();
  });

  it("keeps the games on screen after a failed update and offers Try again", () => {
    const result = games({ syncedAt: null, error: { status: 503, message: "Busy" } });
    footer(result);
    expect(screen.getByRole("status").parentElement?.textContent).toBe("Couldn’t update");
    expect(screen.getByText("3 games")).toBeTruthy();
    expect(keepButton()).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(result.load).toHaveBeenCalledTimes(1);
  });

  it("offers to keep the history for an account this browser doesn't keep, until another tab keeps it", () => {
    noteDeviceCopy("user-b");
    const result = games();
    footer(result);
    expect(screen.getByText("3 games")).toBeTruthy();
    fireEvent.click(keepButton()!);
    expect(result.keepOnDevice).toHaveBeenCalledTimes(1);

    act(() => {
      noteDeviceCopy("user-a");
      window.dispatchEvent(new StorageEvent("storage"));
    });
    expect(keepButton()).toBeNull();
  });

  it("explains why history isn't kept here: too many games, or a browser that refuses storage", () => {
    const view = footer(games({ hitCorpusLimit: true }));
    expect(screen.getByText("Latest 20,000 games")).toBeTruthy();
    expect(screen.getByText("Too many games to keep on this device (over 20,000), so they load each visit.")).toBeTruthy();
    expect(keepButton()).toBeNull();
    view.unmount();

    vi.stubGlobal("indexedDB", undefined);
    const blocked = footer(games());
    expect(screen.getByText("This browser isn’t letting us store data, so your history loads each visit.")).toBeTruthy();
    expect(keepButton()).toBeNull();
    blocked.unmount();

    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    footer(games());
    expect(screen.getByText("This browser isn’t letting us store data, so your history loads each visit.")).toBeTruthy();
    expect(keepButton()).toBeNull();
  });
});
