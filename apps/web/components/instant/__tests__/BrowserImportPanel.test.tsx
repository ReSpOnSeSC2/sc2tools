/**
 * BrowserImportPanel — the backup toggle (visibility, default, effect on
 * hashing, and the intro copy that follows it), the notes about what a
 * selection left out, the status region and focus flow, and the hand-off
 * from a finished parse to the upload runner.
 * `useInstantSession` is a MOCK (no engine), `runBrowserUpload` is a MOCK
 * (no network), and Clerk / useApi / GA4 are mocked.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BrowserUploadInput, BrowserUploadSummary } from "@/lib/instant/importRunner";
import type { InstantSession, UseInstantSessionOptions } from "@/lib/instant/useInstantSession";
import type { ParsedWithFile } from "@/lib/instant/sessionState";
import { BrowserImportPanel } from "../BrowserImportPanel";

const mocks = vi.hoisted(() => ({
  archiveEnabled: true as boolean,
  profile: { pulseIds: ["1-S2-1-111"] } as unknown,
  sessionOptions: [] as UseInstantSessionOptions[],
  session: null as Partial<InstantSession> | null,
  runBrowserUpload: vi.fn(),
}));

vi.mock("@/lib/analytics/gtag", () => ({ gaEvent: vi.fn() }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ getToken: async () => "token" }) }));
vi.mock("@/lib/clientApi", () => ({
  API_BASE: "https://api.test",
  useApi: (path: string | null) => ({
    data: path === "/v1/me/replay-archive-status" ? { enabled: mocks.archiveEnabled } : mocks.profile,
    isLoading: false,
    error: null,
  }),
}));
vi.mock("@/lib/instant/importRunner", () => ({ runBrowserUpload: mocks.runBrowserUpload }));
vi.mock("@/lib/instant/useInstantSession", () => ({
  useInstantSession: (options: UseInstantSessionOptions) => {
    mocks.sessionOptions.push(options);
    return { ...baseSession(), ...mocks.session };
  },
}));

function baseSession(): InstantSession {
  return {
    phase: "idle",
    files: [],
    truncatedCount: 0,
    expanding: false,
    lastIntake: null,
    busy: false,
    dateWindow: { kind: "days90" },
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
  };
}

function lastOptions(): UseInstantSessionOptions {
  const options = mocks.sessionOptions.at(-1);
  if (!options) throw new Error("useInstantSession was not called");
  return options;
}

const PARSED: ParsedWithFile[] = [
  {
    game: {
      ok: true, fileName: "a.SC2Replay", relativePath: "a.SC2Replay", gameId: "g1", json: "{}", date: "2026-09-01T00:00:00Z",
      myToonHandle: "1-S2-1-111", matchFormat: "1v1", isResumedFromReplay: false, ms: 5,
    },
    file: { key: "k", name: "a.SC2Replay", relativePath: "a.SC2Replay", size: 3, lastModified: 1, source: "picker", blob: new Blob(["abc"]) },
  },
];

const SUMMARY: BrowserUploadSummary = {
  uploaded: 1, created: 1, skippedExisting: 0, rejected: 0, pending: 2, stoppedReason: "daily_cap",
  backup: null, backupSkipped: "upload_stopped", toonsSaved: true,
};

beforeEach(() => {
  mocks.archiveEnabled = true;
  mocks.session = null;
  mocks.sessionOptions = [];
  mocks.runBrowserUpload.mockReset();
});

afterEach(cleanup);

describe("BrowserImportPanel backup toggle", () => {
  it("is shown and on by default when the server can store replays", () => {
    render(<BrowserImportPanel />);
    const toggle = screen.getByRole("checkbox", { name: /also back up original replay files/i });
    expect(toggle).toHaveProperty("checked", true);
    expect(lastOptions()).toMatchObject({ wantDigests: true, onlyOneVsOne: false, profileToons: ["1-S2-1-111"] });
  });

  it("stops hashing files when switched off", () => {
    render(<BrowserImportPanel />);
    fireEvent.click(screen.getByRole("checkbox", { name: /also back up original replay files/i }));
    expect(lastOptions().wantDigests).toBe(false);
  });

  it("is hidden when the server has no replay store", () => {
    mocks.archiveEnabled = false;
    render(<BrowserImportPanel />);
    expect(screen.queryByRole("checkbox", { name: /also back up/i })).toBeNull();
    expect(lastOptions().wantDigests).toBe(false);
  });
});

describe("BrowserImportPanel upload", () => {
  it("uploads a finished parse once with the confirmed player and shows the summary", async () => {
    mocks.runBrowserUpload.mockResolvedValue(SUMMARY);
    mocks.session = { phase: "done", parsedWithFiles: PARSED, chosenToon: "1-S2-1-111" };
    const onDone = vi.fn();
    render(<BrowserImportPanel onDone={onDone} />);

    await waitFor(() => expect(screen.getByText("Daily browser upload limit reached")).toBeTruthy());
    expect(mocks.runBrowserUpload).toHaveBeenCalledTimes(1);
    const input = mocks.runBrowserUpload.mock.calls[0]?.[0] as BrowserUploadInput;
    expect(input).toMatchObject({
      parsedWithFiles: PARSED,
      confirmedToons: ["1-S2-1-111"],
      backup: { enabled: true, capabilityEnabled: true },
      apiBase: "https://api.test",
    });
    expect(onDone).toHaveBeenCalledWith(SUMMARY);
    expect(screen.getByRole("link", { name: "Open your dashboard" }).getAttribute("href")).toBe("/app");
  });

  it("offers a retry when the upload fails unexpectedly", async () => {
    mocks.runBrowserUpload.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce({ ...SUMMARY, stoppedReason: undefined, pending: 0 });
    mocks.session = { phase: "done", parsedWithFiles: PARSED, chosenToon: null };
    render(<BrowserImportPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Import complete" })).toBeTruthy();
    expect(mocks.runBrowserUpload).toHaveBeenCalledTimes(2);
    expect((mocks.runBrowserUpload.mock.calls[0]?.[0] as BrowserUploadInput).confirmedToons).toEqual([]);
  });

  it("starts the analysis from the queued files", () => {
    const start = vi.fn(async () => undefined);
    mocks.session = { phase: "ready", files: PARSED.map((entry) => entry.file), start };
    render(<BrowserImportPanel compact />);
    fireEvent.click(screen.getByRole("button", { name: "Analyze and upload 1 replay" }));
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("announces the result through one always-mounted region and focuses the summary", async () => {
    let finish: (value: BrowserUploadSummary) => void = () => undefined;
    mocks.runBrowserUpload.mockReturnValue(new Promise<BrowserUploadSummary>((resolve) => (finish = resolve)));
    mocks.session = { phase: "done", parsedWithFiles: PARSED, chosenToon: null };
    render(<BrowserImportPanel />);
    const region = screen.getAllByRole("status").find((node) => node.getAttribute("aria-live") === "polite" && node.className.includes("sr-only"));
    if (!region) throw new Error("status region missing");
    await waitFor(() => expect(region.textContent).toBe("Uploading your games…"));
    expect(document.activeElement?.textContent).toBe("Preparing the upload…");
    finish({ ...SUMMARY, stoppedReason: undefined, pending: 0 });
    const heading = await screen.findByRole("heading", { name: "Import complete" });
    expect(region.textContent).toBe("Import complete");
    expect(heading.closest("[role=status]")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });
});

describe("BrowserImportPanel intake notes and intro", () => {
  it("says when a selection held no replays", () => {
    mocks.session = { lastIntake: { found: 0, added: 0, ignored: 3, rejected: 0 } };
    render(<BrowserImportPanel />);
    const note = screen.getByText("No .SC2Replay files in that selection.");
    expect(note.closest("[role=status]")).not.toBeNull();
  });

  it("says how many replays the 500-file cap left out", () => {
    mocks.session = { phase: "ready", files: PARSED.map((entry) => entry.file), truncatedCount: 2500 };
    render(<BrowserImportPanel />);
    expect(screen.getByText(/Only the newest 500 replays are imported in one run; 2500 older ones were left out/)).toBeTruthy();
  });

  it("mentions the replay-file copy while the backup is on, and never says only the analysis is uploaded", () => {
    render(<BrowserImportPanel />);
    const intro = screen.getByText(/then the results are uploaded to your account/);
    expect(intro.textContent).toMatch(/private copy of each replay file/);
    expect(intro.textContent).not.toMatch(/\bonly\b/);
    fireEvent.click(screen.getByRole("checkbox", { name: /also back up original replay files/i }));
    expect(screen.getByText(/then the results are uploaded to your account/).textContent).toMatch(/Replay files stay on this device/);
  });

  it("warms the analyzer up on the first intent, not on mount", () => {
    const prewarm = vi.fn();
    mocks.session = { prewarm };
    render(<BrowserImportPanel />);
    expect(prewarm).not.toHaveBeenCalled();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Choose replays" }));
    expect(prewarm).toHaveBeenCalled();
  });
});
