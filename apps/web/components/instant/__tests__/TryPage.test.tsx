/**
 * TryPage — the /try states driven by a MOCKED useInstantSession (no
 * worker, no Pyodide), with IndexedDB, Clerk, the router and GA mocked.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { StoredTryGame, TryGameInput } from "@/lib/instant/localStore";
import type { ParsedGame } from "@/lib/instant/types";
import type { InstantSession } from "@/lib/instant/useInstantSession";

const mocks = vi.hoisted(() => ({
  session: null as InstantSession | null,
  gate: { enabled: true, mode: "admins", loading: false },
  gaEvent: vi.fn(),
  saveTryGames: vi.fn(async (_games: ReadonlyArray<TryGameInput>, _now: number) => undefined),
  loadTryGames: vi.fn(async (_now: number): Promise<StoredTryGame[]> => []),
  clearTryData: vi.fn(async () => undefined),
}));

vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: false, getToken: async () => null }) }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("@/lib/analytics/gtag", () => ({ gaEvent: mocks.gaEvent }));
vi.mock("@/lib/clientApi", () => ({ API_BASE: "https://api.test" }));
vi.mock("@/lib/instant/localStore", () => ({
  TRY_TTL_DAYS: 7,
  saveTryGames: mocks.saveTryGames,
  loadTryGames: mocks.loadTryGames,
  clearTryData: mocks.clearTryData,
}));
vi.mock("@/lib/instant/useInstantImport", () => ({ useInstantImport: () => mocks.gate }));
vi.mock("@/lib/instant/useInstantSession", () => ({
  useInstantSession: () => {
    if (!mocks.session) throw new Error("set mocks.session first");
    return mocks.session;
  },
}));

import { INSTANT_ENGINE_VERSION } from "@/lib/instant/engineVersion";
import { PRIVACY_LINE, TryPage } from "../TryPage";

const RAW = readFileSync(path.join(__dirname, "../../../lib/instant/__tests__/fixtures/warpgate_payload.json"), "utf8");
const GAME_ID = "2026-05-08T19:08:12|Squirtuoz|Tourmaline LE|470";
const DATE = "2026-05-08T19:08:12Z";

function parsedGame(): ParsedGame {
  return {
    ok: true,
    fileName: "a.SC2Replay",
    relativePath: "a.SC2Replay",
    gameId: GAME_ID,
    json: RAW,
    date: DATE,
    myToonHandle: "1-S2-1-267727",
    matchFormat: "1v1",
    isResumedFromReplay: false,
    ms: 1200,
  };
}

function storedGame(): StoredTryGame {
  return { gameId: GAME_ID, json: RAW, date: DATE, engineVersion: "1.6.3", storedAt: 1, expiresAt: 2 };
}

function makeSession(overrides: Partial<InstantSession> = {}): InstantSession {
  return {
    phase: "idle",
    files: [],
    truncatedCount: 0,
    expanding: false,
    lastIntake: null,
    busy: false,
    dateWindow: { kind: "all" },
    estimate: null,
    progress: null,
    candidates: [],
    meMode: null,
    chosenToon: null,
    parsed: [],
    parsedWithFiles: [],
    failed: [],
    error: null,
    engineInfo: null,
    addFiles: vi.fn(async () => undefined),
    setDateWindow: vi.fn(),
    start: vi.fn(async () => undefined),
    choose: vi.fn(async () => undefined),
    cancel: vi.fn(),
    reset: vi.fn(),
    lastHeapBytes: () => null,
    prewarm: vi.fn(),
    ...overrides,
  };
}

function events(name: string): number {
  return mocks.gaEvent.mock.calls.filter((call) => call[0] === name).length;
}

beforeEach(() => {
  mocks.session = makeSession();
  mocks.gate = { enabled: true, mode: "admins", loading: false };
  mocks.loadTryGames.mockResolvedValue([]);
  mocks.saveTryGames.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("TryPage intake and progress", () => {
  it("shows the privacy line and the intake, and tracks one open", async () => {
    render(<TryPage mode="all" />);
    expect(screen.getByRole("heading", { level: 1, name: "Analyze your replays in your browser" })).toBeTruthy();
    expect(screen.getByText(PRIVACY_LINE)).toBeTruthy();
    expect(screen.getByText("Add your replays")).toBeTruthy();
    expect(screen.getByText("In your browser vs the desktop agent")).toBeTruthy();
    await waitFor(() => expect(mocks.loadTryGames).toHaveBeenCalled());
    expect(events("instant_open")).toBe(1);
    expect(screen.queryByRole("heading", { name: "Your instant report" })).toBeNull();
  });

  it("starts the analysis as soon as replays are picked", async () => {
    const session = makeSession();
    mocks.session = session;
    render(<TryPage mode="all" />);
    const file = new File([new Uint8Array([1])], "a.SC2Replay");
    fireEvent.change(screen.getByLabelText("Replay files"), { target: { files: [file] } });
    await waitFor(() => expect(session.start).toHaveBeenCalledTimes(1));
    expect(session.addFiles).toHaveBeenCalledWith([file], "picker");
  });

  it("asks which player you are while choosing", () => {
    const session = makeSession({ phase: "choosing", busy: true, candidates: [{ toon: "1-S2-1-267727", name: "ReSpOnSe", race: "Protoss", games: 1 }] });
    mocks.session = session;
    render(<TryPage mode="all" />);
    fireEvent.click(screen.getByRole("button", { name: "ReSpOnSe · Protoss · 1 game" }));
    expect(session.choose).toHaveBeenCalledWith("1-S2-1-267727");
  });

  it("shows progress while parsing", () => {
    mocks.session = makeSession({ phase: "parsing", busy: true, progress: { phase: "parse", index: 0, total: 3, done: 1, fileName: "" } });
    render(<TryPage mode="all" />);
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("1");
    expect(screen.queryByText("Add your replays")).toBeNull();
  });

});

describe("TryPage report", () => {
  it("stores finished games on the device and shows the report", async () => {
    const { rerender } = render(<TryPage mode="all" />);
    mocks.loadTryGames.mockResolvedValue([storedGame()]);
    mocks.session = makeSession({ phase: "done", parsed: [parsedGame()] });
    rerender(<TryPage mode="all" />);
    expect(await screen.findByRole("heading", { name: "Your instant report" })).toBeTruthy();
    expect(mocks.saveTryGames).toHaveBeenCalledWith(
      [{ gameId: GAME_ID, json: RAW, date: DATE, engineVersion: INSTANT_ENGINE_VERSION }],
      expect.any(Number),
    );
    expect(screen.getByTestId("report-matchups")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Save these games to your free account" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Clear local data" })).toBeTruthy();
    // The view event fires from an effect after the report commits.
    await waitFor(() => expect(events("instant_report_view")).toBe(1));
  });

  it("moves focus to the report once a run finishes (the progress panel goes away)", async () => {
    const { rerender } = render(<TryPage mode="all" />);
    mocks.loadTryGames.mockResolvedValue([storedGame()]);
    mocks.session = makeSession({ phase: "done", parsed: [parsedGame()] });
    rerender(<TryPage mode="all" />);
    const heading = await screen.findByRole("heading", { name: "Your instant report" });
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  it("does not steal focus when a revisit shows the stored report", async () => {
    mocks.loadTryGames.mockResolvedValue([storedGame()]);
    render(<TryPage mode="all" />);
    const heading = await screen.findByRole("heading", { name: "Your instant report" });
    expect(document.activeElement).not.toBe(heading);
  });

});

describe("TryPage report storage and notes", () => {
  it("announces when a selection holds no replays, with an icon and full-contrast text", () => {
    mocks.session = makeSession({ lastIntake: { found: 0, added: 0, ignored: 2, rejected: 0 } });
    render(<TryPage mode="all" />);
    const note = screen.getByText(/didn't find any StarCraft II replays/).closest("[role=status]");
    expect(note).not.toBeNull();
    expect(note?.className).toContain("text-text");
    expect(note?.className).not.toContain("text-warning");
    expect(note?.querySelector("svg")).not.toBeNull();
  });

  it("saves each game with the engine version that parsed it", async () => {
    const engineInfo = { engineVersion: "1.6.2", pyodideVersion: "314.0.7", pythonVersion: "3.14", bundleId: "b", bootMs: 1 };
    mocks.session = makeSession({ phase: "done", parsed: [parsedGame()], engineInfo });
    render(<TryPage mode="all" />);
    await waitFor(() => expect(mocks.saveTryGames).toHaveBeenCalled());
    expect(mocks.saveTryGames.mock.calls[0]?.[0]).toEqual([{ gameId: GAME_ID, json: RAW, date: DATE, engineVersion: "1.6.2" }]);
  });

  it("keeps the report in memory with a note when storage is unavailable", async () => {
    mocks.saveTryGames.mockRejectedValue(new Error("QuotaExceededError"));
    mocks.session = makeSession({ phase: "done", parsed: [parsedGame()] });
    render(<TryPage mode="all" />);
    expect(await screen.findByRole("heading", { name: "Your instant report" })).toBeTruthy();
    expect(screen.getByText(/isn't letting us store data/)).toBeTruthy();
    expect(mocks.gaEvent).toHaveBeenCalledWith("instant_error", { kind: "storage_unavailable" });
  });

  it("shows the stored report on a revisit, with Analyze more replays", async () => {
    mocks.loadTryGames.mockResolvedValue([storedGame()]);
    const session = makeSession();
    mocks.session = session;
    render(<TryPage mode="all" />);
    expect(await screen.findByRole("heading", { name: "Your instant report" })).toBeTruthy();
    expect(screen.queryByText("Add your replays")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Analyze more replays" }));
    expect(session.reset).toHaveBeenCalled();
    expect(screen.getByText("Add your replays")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back to your report" })).toBeTruthy();
  });

});

describe("TryPage keyboard focus and warm-up", () => {
  it("moves focus into the progress panel when a run starts", () => {
    const { rerender } = render(<TryPage mode="all" />);
    screen.getByRole("button", { name: "Choose replays" }).focus();
    mocks.session = makeSession({ phase: "booting", busy: true });
    rerender(<TryPage mode="all" />);
    expect(document.activeElement?.textContent).toMatch(/Starting the analyzer/);
  });

  it("moves focus onto the intake after Analyze more replays", async () => {
    mocks.loadTryGames.mockResolvedValue([storedGame()]);
    render(<TryPage mode="all" />);
    fireEvent.click(await screen.findByRole("button", { name: "Analyze more replays" }));
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Add your replays"));
  });

  it("moves focus onto the intake after clearing local data", async () => {
    mocks.loadTryGames.mockResolvedValue([storedGame()]);
    const session = makeSession();
    mocks.session = session;
    render(<TryPage mode="all" />);
    fireEvent.click(await screen.findByRole("button", { name: "Clear local data" }));
    const confirm = Array.from(screen.getByRole("dialog").querySelectorAll("button")).find(
      (button) => button.textContent === "Clear local data",
    );
    if (!confirm) throw new Error("confirm button missing");
    fireEvent.click(confirm);
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Add your replays"));
    expect(session.prewarm).not.toHaveBeenCalled();
  });

  it("warms the analyzer up on the first intent, never on mount", () => {
    const session = makeSession();
    mocks.session = session;
    render(<TryPage mode="all" />);
    expect(session.prewarm).not.toHaveBeenCalled();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Choose replays" }));
    expect(session.prewarm).toHaveBeenCalled();
  });
});

describe("TryPage errors and rollout gate", () => {
  it("says when nothing could be analyzed", () => {
    mocks.session = makeSession({ phase: "done", failed: [{ ok: false, fileName: "", relativePath: "", errorKind: "ai_game", ms: 1 }] });
    render(<TryPage mode="all" />);
    expect(screen.getByText("None of these replays could be analyzed.")).toBeTruthy();
    expect(screen.getByText(/Games vs the AI/)).toBeTruthy();
  });

  it("explains an engine error and retries", () => {
    const session = makeSession({ phase: "error", error: "engine_boot_failed" });
    mocks.session = session;
    render(<TryPage mode="all" />);
    expect(screen.getByRole("alert")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(session.start).toHaveBeenCalled();
  });

  it("shows Coming soon to non-admins in admins mode", () => {
    mocks.gate = { enabled: false, mode: "admins", loading: false };
    render(<TryPage mode="admins" />);
    expect(screen.getByText("Coming soon")).toBeTruthy();
    expect(screen.queryByText("Add your replays")).toBeNull();
    expect(events("instant_open")).toBe(0);
  });

  it("gives admins the tool in admins mode", () => {
    render(<TryPage mode="admins" />);
    expect(screen.getByText("Add your replays")).toBeTruthy();
  });
});
