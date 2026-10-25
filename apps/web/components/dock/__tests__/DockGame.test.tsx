import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { DockGame } from "../DockGame";
import { DockStatusHeader } from "../DockStatusHeader";
import { DEFAULT_STUDIO_STATE } from "@/lib/multichat/useStudioState";
import { EMPTY_ENGAGEMENT } from "@/lib/multichat/useEngagementState";
import type { ComponentProps } from "react";
vi.mock("../DockPresenceStrip", () => ({ DockPresenceStrip: () => <div>Counts only</div> }));
const NOW = 1_700_000_000_000;
function props(): ComponentProps<typeof DockGame> {
  return { token: "owner-token", live: { type: "liveGameState", phase: "match_in_progress", gameKey: "game", capturedAt: NOW / 1000, receivedAt: NOW, user: { race: "Protoss" }, opponent: { name: "Public Opponent", race: "Zerg", profile: { mmr: 5100 } }, opponentChannels: { twitch: "https://www.twitch.tv/approved" } }, lastLiveAt: NOW,
    gameStatus: { gameKey: "game", phase: "match_in_progress", isReplay: false, verified: false },
    session: { wins: 3, losses: 2, games: 5, mmrStart: 5000, mmrCurrent: 5020, streak: { kind: "win", count: 2 } },
    studio: DEFAULT_STUDIO_STATE, engagement: { ...EMPTY_ENGAGEMENT, prediction: { gameKey: "game", opponent: "Public Opponent", locksAtMs: NOW + 30_000, tally: { win: 3, loss: 1, total: 4 } } }, ready: true, busy: false, onPost: vi.fn(async () => DEFAULT_STUDIO_STATE) };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
it("shows current stream-safe facts, honest map gap, session and vote countdown", () => {
  render(<DockGame {...props()} />);
  expect(screen.getByText("Public Opponent")).toBeTruthy(); expect(screen.getByText("PvZ · Map unavailable live")).toBeTruthy();
  expect(screen.getByText("3W–2L · +20 MMR")).toBeTruthy(); expect(screen.getByText("2 wins in a row")).toBeTruthy();
  expect(screen.getByRole("progressbar", { name: "Crystal Ball votes" }).getAttribute("aria-valuetext")).toBe("3 win, 1 loss");
  expect(screen.getByText(/Locks in 00:30/)).toBeTruthy();
  act(() => vi.advanceTimersByTime(30_001)); expect(screen.getByText(/Voting locked/)).toBeTruthy();
});
it.each(["active", "replay", "verified", "different-key"])("cannot manually resolve %s game state", state => {
  const p = props(); p.gameStatus = { gameKey: state === "different-key" ? "other" : "game", phase: state === "active" ? "match_in_progress" : "match_ended", isReplay: state === "replay", verified: state === "verified" };
  render(<DockGame {...p} />); const button = screen.getByRole("button", { name: "Resolve Win" }) as HTMLButtonElement;
  expect(button.disabled).toBe(true); fireEvent.click(button); expect(p.onPost).not.toHaveBeenCalled(); expect(screen.queryByRole("dialog")).toBeNull();
});
it("requires confirmation of exact manual result and defaults to safe Cancel", async () => {
  const p = props(); p.live = null; p.gameStatus = { gameKey: "game", phase: "match_ended", isReplay: false, verified: false };
  render(<DockGame {...p} />); fireEvent.click(screen.getByRole("button", { name: "Resolve Loss" }));
  const dialog = screen.getByRole("dialog", { name: "Resolve Loss manually?" });
  expect(p.onPost).not.toHaveBeenCalled(); expect(within(dialog).getByText(/No points or oracle accuracy/)).toBeTruthy();
  act(() => vi.advanceTimersByTime(1)); expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
  await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Resolve manually" })));
  expect(p.onPost).toHaveBeenCalledWith({ action: "predictionResolve", gameKey: "game", result: "loss" });
});
it("a warm owner/cohort change closes confirmation and drops late shoutout receipts", async () => {
  const p = props(); let finish!: (value: typeof DEFAULT_STUDIO_STATE) => void;
  p.onPost = vi.fn(() => new Promise<typeof DEFAULT_STUDIO_STATE>(resolve => { finish = resolve; }));
  const view = render(<DockGame {...p} />); fireEvent.click(screen.getByRole("button", { name: "Shout out" }));
  view.rerender(<DockGame {...p} token="another-owner" />);
  await act(async () => finish({ ...DEFAULT_STUDIO_STATE, deskAction: { shoutoutText: "Old channel", queued: false } }));
  expect(screen.queryByText("Old channel")).toBeNull(); expect(screen.queryByRole("button", { name: "Copy shout-out" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Cancel round" })); expect(screen.getByRole("dialog")).toBeTruthy();
  view.rerender(<DockGame {...p} token="third-owner" />); expect(screen.queryByRole("dialog")).toBeNull();
});
it("pause posts the exact reversible boolean and reset waits for confirmation", async () => {
  const p = props(); render(<DockGame {...p} />);
  fireEvent.click(screen.getByRole("button", { name: "Hide game widgets" })); expect(p.onPost).toHaveBeenCalledWith({ action: "gamePause", paused: true });
  fireEvent.click(screen.getByRole("button", { name: "Start new session" })); expect(p.onPost).not.toHaveBeenCalledWith({ action: "sessionReset" });
  await act(async () => fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Start new session" })));
  expect(p.onPost).toHaveBeenCalledWith({ action: "sessionReset" });
});
it("moves focus to progress while a confirmed control is busy and keeps Escape inside", () => {
  const p = props(); const view = render(<DockGame {...p} />);
  fireEvent.click(screen.getByRole("button", { name: "Cancel round" }));
  view.rerender(<DockGame {...p} busy />);
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByRole("status").textContent).toBe("Saving game control…");
  expect(document.activeElement).toBe(within(dialog).getByRole("status"));
  fireEvent.keyDown(document, { key: "Escape" }); expect(screen.getByRole("dialog")).toBe(dialog);
});
it("header removes opponent on end/staleness, labels connection and retains counts", () => {
  const p = props(); const base = { token: p.token, studio: { ...DEFAULT_STUDIO_STATE, scene: { mode: "brb" as const, message: "", countdownEndsAt: NOW + 192_000, setAtMs: NOW } }, ready: true, live: p.live, lastLiveAt: NOW, session: p.session, status: "connected", onHeight: vi.fn(), children: <nav>Jump tabs</nav> };
  const view = render(<DockStatusHeader {...base} />);
  expect(screen.getByText(/BRB 03:12/)).toBeTruthy(); expect(screen.getByRole("status").textContent).toBe("Connected"); expect(screen.getByLabelText("Current opponent").textContent).toContain("Public Opponent");
  act(() => vi.advanceTimersByTime(31_000)); expect(screen.queryByLabelText("Current opponent")).toBeNull();
  view.rerender(<DockStatusHeader {...base} live={null} status="reconnecting" />); expect(screen.getByRole("status").textContent).toBe("Reconnecting…"); expect(screen.getByText("Counts only")).toBeTruthy();
});
