/**
 * TryResume / SaveGamesCta / useTryUpload — the "save these games" card
 * and the ?resume=1 hand-off, with Clerk, the router, IndexedDB and the
 * uploader mocked (no network, no storage).
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { StoredTryGame } from "@/lib/instant/localStore";
import type { UploadDeps, UploadSummary } from "@/lib/instant/uploader";
import type { UploadableGame } from "@/lib/instant/types";

const mocks = vi.hoisted(() => ({
  auth: { isLoaded: true, isSignedIn: false },
  getToken: vi.fn(async () => "token"),
  push: vi.fn(),
  search: "",
  gaEvent: vi.fn(),
  loadTryGames: vi.fn(async (): Promise<StoredTryGame[]> => []),
  clearTryData: vi.fn(async () => undefined),
  uploadGames: vi.fn(),
}));

vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ ...mocks.auth, getToken: mocks.getToken }) }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
  useSearchParams: () => new URLSearchParams(mocks.search),
}));
vi.mock("@/lib/analytics/gtag", () => ({ gaEvent: mocks.gaEvent }));
vi.mock("@/lib/clientApi", () => ({ API_BASE: "https://api.test" }));
vi.mock("@/lib/instant/localStore", () => ({ loadTryGames: mocks.loadTryGames, clearTryData: mocks.clearTryData }));
vi.mock("@/lib/instant/uploader", () => ({ uploadGames: mocks.uploadGames }));

import { SaveGamesCta, TryResume, classifyUpload, useTryUpload } from "../TryResume";

const GAMES: UploadableGame[] = [
  { gameId: "g1", json: '{"gameId":"g1"}' },
  { gameId: "g2", json: '{"gameId":"g2"}' },
];

function stored(): StoredTryGame[] {
  return GAMES.map((game) => ({ ...game, date: "2026-05-08T19:08:12Z", storedAt: 1, expiresAt: 2 }));
}

function summary(overrides: Partial<UploadSummary> = {}): UploadSummary {
  return { accepted: [], rejected: [], skippedExisting: [], oversized: [], pending: [], ...overrides };
}

function accepted(ids: string[]): UploadSummary["accepted"] {
  return ids.map((gameId) => ({ gameId, created: true }));
}

function Cta({ games = GAMES }: { games?: UploadableGame[] }) {
  const upload = useTryUpload();
  return <SaveGamesCta upload={upload} games={games} />;
}

function Resume({ onResume = () => undefined, games = GAMES }: { onResume?: () => void; games?: UploadableGame[] }) {
  const upload = useTryUpload();
  return <TryResume upload={upload} games={games} onResume={onResume} />;
}

function events(): string[] {
  return mocks.gaEvent.mock.calls.map((call) => String(call[0]));
}

beforeEach(() => {
  mocks.auth = { isLoaded: true, isSignedIn: false };
  mocks.search = "";
  mocks.uploadGames.mockResolvedValue(summary({ accepted: accepted(["g1", "g2"]) }));
  mocks.loadTryGames.mockResolvedValue(stored());
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("classifyUpload", () => {
  it("is done when every game is accepted or already stored", () => {
    expect(classifyUpload(summary({ accepted: accepted(["g1"]), skippedExisting: ["g2"] }))).toEqual({ status: "done", accepted: 1 });
    expect(classifyUpload(summary({ skippedExisting: ["g1"] }))).toEqual({ status: "done", accepted: 0 });
  });

  it("reports the stop reason with accepted and pending counts", () => {
    expect(classifyUpload(summary({ accepted: accepted(["g1"]), pending: ["g2"], stoppedReason: "daily_cap" }))).toEqual({
      status: "stopped",
      reason: "daily_cap",
      accepted: 1,
      pending: 1,
    });
  });

  it("treats an all-rejected run as rejected and an aborted run as nothing", () => {
    expect(classifyUpload(summary({ rejected: [{ gameId: "g1", errors: ["bad"] }] }))).toMatchObject({ reason: "rejected", pending: 1 });
    expect(classifyUpload(summary({ stoppedReason: "aborted" }))).toBeNull();
  });
});

describe("SaveGamesCta signed out", () => {
  it("links signed-out visitors to sign-up and sign-in with the /try resume redirect", () => {
    render(<Cta />);
    const signUp = screen.getByRole("link", { name: "Create a free account" });
    expect(signUp.getAttribute("href")).toBe("/sign-up?redirect_url=%2Ftry%3Fresume%3D1");
    expect(screen.getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe("/sign-in?redirect_url=%2Ftry%3Fresume%3D1");
    // jsdom cannot navigate; stop the anchor's default after React saw the click.
    const block = (event: Event) => event.preventDefault();
    window.addEventListener("click", block);
    fireEvent.click(signUp);
    window.removeEventListener("click", block);
    expect(events()).toContain("instant_signup_click");
  });

  it("shows the sign-up links while Clerk is still loading", () => {
    mocks.auth = { isLoaded: false, isSignedIn: false };
    render(<Cta />);
    expect(screen.getByRole("link", { name: "Create a free account" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Save 2 games/ })).toBeNull();
  });

});

describe("SaveGamesCta signed in", () => {
  it("uploads the games for a signed-in visitor, then clears local data and opens /app", async () => {
    mocks.auth = { isLoaded: true, isSignedIn: true };
    render(<Cta />);
    fireEvent.click(screen.getByRole("button", { name: "Save 2 games to my account" }));
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/app"));
    const [games, deps] = mocks.uploadGames.mock.calls[0] as [UploadableGame[], UploadDeps];
    expect(games).toEqual(GAMES);
    expect(deps).toMatchObject({ apiBase: "https://api.test", engineVersion: "1.6.3" });
    expect(mocks.clearTryData).toHaveBeenCalledTimes(1);
    expect(mocks.gaEvent).toHaveBeenCalledWith("instant_upload_done", { games: 2 });
    expect(screen.getByText(/Saved! Taking you to your dashboard/)).toBeTruthy();
  });

  it("keeps a polite status region mounted before the upload starts", async () => {
    mocks.auth = { isLoaded: true, isSignedIn: true };
    let finish: (value: UploadSummary) => void = () => undefined;
    mocks.uploadGames.mockReturnValue(new Promise<UploadSummary>((resolve) => (finish = resolve)));
    render(<Cta />);
    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.textContent).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Save 2 games to my account" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/Checking which games/));
    expect(screen.getByRole("status")).toBe(status);
    await act(async () => finish(summary({ accepted: accepted(["g1", "g2"]) })));
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/app"));
  });

});

describe("SaveGamesCta stopped uploads", () => {
  it("explains the daily cap and keeps the games on the device", async () => {
    mocks.auth = { isLoaded: true, isSignedIn: true };
    mocks.uploadGames.mockResolvedValue(summary({ accepted: accepted(["g1"]), pending: ["g2"], stoppedReason: "daily_cap" }));
    render(<Cta />);
    fireEvent.click(screen.getByRole("button", { name: "Save 2 games to my account" }));
    expect(await screen.findByText("You've reached today's upload limit")).toBeTruthy();
    expect(screen.getByText(/Saved 1 game\. The other 1 game stay on this device/)).toBeTruthy();
    expect(mocks.clearTryData).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
    expect(mocks.gaEvent).toHaveBeenCalledWith("instant_error", { kind: "upload_daily_cap" });
  });

  it("asks to sign in again after an auth stop", async () => {
    mocks.auth = { isLoaded: true, isSignedIn: true };
    mocks.uploadGames.mockResolvedValue(summary({ pending: ["g1", "g2"], stoppedReason: "auth" }));
    render(<Cta />);
    fireEvent.click(screen.getByRole("button", { name: "Save 2 games to my account" }));
    const link = await screen.findByRole("link", { name: "Sign in again" });
    expect(link.getAttribute("href")).toBe("/sign-in?redirect_url=%2Ftry%3Fresume%3D1");
  });

  it("offers a retry after a server stop and re-uploads the same games", async () => {
    mocks.auth = { isLoaded: true, isSignedIn: true };
    mocks.uploadGames.mockResolvedValueOnce(summary({ pending: ["g1", "g2"], stoppedReason: "server" }));
    render(<Cta />);
    fireEvent.click(screen.getByRole("button", { name: "Save 2 games to my account" }));
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/app"));
    expect(mocks.uploadGames).toHaveBeenCalledTimes(2);
    expect(mocks.uploadGames.mock.calls[1]?.[0]).toEqual(GAMES);
  });
});

describe("TryResume", () => {
  it("renders nothing without ?resume=1", () => {
    const { container } = render(<Resume />);
    expect(container.innerHTML).toBe("");
    expect(mocks.loadTryGames).not.toHaveBeenCalled();
  });

  it("uploads the stored games (no re-parse) when signed in with ?resume=1", async () => {
    mocks.search = "resume=1";
    mocks.auth = { isLoaded: true, isSignedIn: true };
    const onResume = vi.fn();
    render(<Resume onResume={onResume} />);
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/app"));
    expect(onResume).toHaveBeenCalled();
    expect(mocks.loadTryGames).toHaveBeenCalledTimes(1);
    expect(mocks.uploadGames).toHaveBeenCalledTimes(1);
    expect(mocks.uploadGames.mock.calls[0]?.[0]).toEqual(GAMES);
    expect(mocks.clearTryData).toHaveBeenCalledTimes(1);
  });

  it("says so when nothing is stored on this device", async () => {
    mocks.search = "resume=1";
    mocks.auth = { isLoaded: true, isSignedIn: true };
    mocks.loadTryGames.mockResolvedValue([]);
    render(<Resume games={[]} />);
    expect(await screen.findByText(/No games from this page are stored on this device/)).toBeTruthy();
    expect(mocks.uploadGames).not.toHaveBeenCalled();
  });

  it("still offers to save games shown on the page when nothing was stored", async () => {
    mocks.search = "resume=1";
    mocks.auth = { isLoaded: true, isSignedIn: true };
    mocks.loadTryGames.mockResolvedValue([]);
    render(<Resume />);
    await waitFor(() => expect(mocks.loadTryGames).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole("button", { name: "Save 2 games to my account" }));
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/app"));
    expect(mocks.uploadGames.mock.calls[0]?.[0]).toEqual(GAMES);
  });

  it("still shows the save card while Clerk has not loaded", () => {
    mocks.search = "resume=1";
    mocks.auth = { isLoaded: false, isSignedIn: false };
    const onResume = vi.fn();
    render(<Resume onResume={onResume} />);
    expect(onResume).toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "Create a free account" })).toBeTruthy();
    expect(mocks.loadTryGames).not.toHaveBeenCalled();
  });

  it("shows the save card again when signed out", async () => {
    mocks.search = "resume=1";
    render(<Resume />);
    expect(screen.getByRole("link", { name: "Create a free account" })).toBeTruthy();
    await act(async () => undefined);
    expect(mocks.uploadGames).not.toHaveBeenCalled();
  });
});
