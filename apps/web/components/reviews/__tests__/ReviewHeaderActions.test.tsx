import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReviewPageData } from "@/lib/reviews";
const h = vi.hoisted(() => ({ apiCall: vi.fn(), changed: vi.fn(), signedIn: true }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ getToken: async () => "token", isSignedIn: h.signedIn, isLoaded: true, userId: "viewer" }) }));
vi.mock("@/lib/clientApi", async (original) => ({ ...await original<typeof import("@/lib/clientApi")>(), apiCall: h.apiCall }));
vi.mock("@/components/maps/MapArtwork", () => ({ MapArtwork: () => null }));
vi.mock("../ReviewReplayPanel", () => ({ ReviewReplayPanel: () => null }));
vi.mock("../ReviewShareMenu", () => ({ ReviewShareMenu: () => <button>Share</button> }));
vi.mock("../ReviewReplayDownload", () => ({ ReviewReplayDownload: () => <button>Download replay</button> }));
import { RequestHeader } from "../ReviewPage";

function fixture(): ReviewPageData {
  return {
    request: { id: "request", url: "/reviews/request", question: "How should I defend this attack?", tags: [], timeRange: null,
      desiredLevel: "anyone", visibility: "public", status: "open", closedReason: null, hidden: false,
      asker: { label: "Asker", anonymous: true, band: null, mmr: null, isYou: true },
      game: { matchup: "PvZ", myRace: "Protoss", oppRace: "Zerg", map: "Alcyone LE", result: "Loss", durationSec: 640, myBuild: null, oppStrategy: null, macroScore: null, hasPlayback: true },
      opponent: { label: "Opponent", race: "Zerg", band: null, mmr: null },
      stats: { reviewCount: 0, commentCount: 0, helpfulCount: 0, upvoteTotal: 0 }, bestCommentId: null, createdAt: null, lastActivityAt: null,
      replay: { shared: true, available: true, optedIn: true } },
    comments: [], viewer: { signedIn: true, isAsker: true, isAdmin: false, canComment: true, reason: null },
    seo: { indexable: false, answerCount: 0, acceptedAnswerId: null, suggestedAnswerIds: [] },
  };
}
beforeEach(() => { h.apiCall.mockReset().mockResolvedValue({}); h.changed.mockReset().mockResolvedValue(undefined); h.signedIn = true; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("puts download/share in the action row and keeps asker tools closed by default, only for an active asker", () => {
  const data = fixture(); const { container, rerender } = render(<RequestHeader data={data} onChanged={h.changed} />);
  expect(screen.getByRole("button", { name: "Download replay" })).toBeTruthy(); expect(screen.getByRole("button", { name: "Share" })).toBeTruthy();
  expect(container.querySelector("details")?.open).toBe(false); expect(screen.queryByRole("button", { name: "Request actions" })).toBeNull();
  data.request.asker.isYou = false; rerender(<RequestHeader data={data} onChanged={h.changed} />);
  expect(container.querySelector("details")).toBeNull(); expect(screen.getByRole("button", { name: "Request actions" })).toBeTruthy();
  data.request.asker.isYou = true; data.request.status = "closed"; rerender(<RequestHeader data={data} onChanged={h.changed} />);
  expect(container.querySelector("details")).toBeNull();
});

it("confirms closing with the irreversible effect, stays open while posting and never calls window.confirm", async () => {
  const confirm = vi.spyOn(window, "confirm"); let finish!: (value: object) => void;
  h.apiCall.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  render(<RequestHeader data={fixture()} onChanged={h.changed} />); fireEvent.click(screen.getByText("Asker tools"));
  fireEvent.click(screen.getByRole("button", { name: "Close request" }));
  const dialog = screen.getByRole("dialog", { name: "Close this request?" });
  expect(dialog.textContent).toContain("New comments stop and the replay analysis is no longer shared. The thread stays readable. You can't reopen it.");
  fireEvent.click(within(dialog).getByRole("button", { name: "Close request" }));
  expect(h.apiCall).toHaveBeenCalledWith(expect.any(Function), "/v1/reviews/request/close", { method: "POST", body: "{}", signal: expect.any(AbortSignal) });
  expect((within(dialog).getByRole("button", { name: "Close request" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.keyDown(dialog, { key: "Escape" }); expect(screen.getByRole("dialog")).toBeTruthy();
  await act(async () => finish({})); expect(screen.queryByRole("dialog")).toBeNull(); expect(h.changed).toHaveBeenCalledOnce(); expect(confirm).not.toHaveBeenCalled();
});

it("preserves the saved replay choice while hidden, explains privacy and shows a sharing failure", async () => {
  const data = fixture(); data.request.hidden = true; data.request.replay = { optedIn: true, shared: false, available: true };
  h.apiCall.mockRejectedValue({ message: "Sharing service is busy." }); render(<RequestHeader data={data} onChanged={h.changed} />);
  fireEvent.click(screen.getByText("Asker tools")); const toggle = screen.getByRole("switch", { name: "Let reviewers download my replay file" });
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  expect(screen.getByText(/Downloads are paused while this request is hidden/)).toBeTruthy();
  expect(screen.getByText(/It contains both players/).textContent).toContain("in-game chat");
  fireEvent.click(toggle); expect((await screen.findByRole("alert")).textContent).toBe("Sharing service is busy.");
  expect(JSON.parse(h.apiCall.mock.calls[0][2].body)).toEqual({ value: false });
});

it.each([true, false])("reports a whole request and explains whether it was already reported (%s)", async (alreadyReported) => {
  const data = fixture(); data.request.asker.isYou = false; h.apiCall.mockResolvedValue({ alreadyReported });
  render(<RequestHeader data={data} onChanged={h.changed} />);
  fireEvent.click(screen.getByRole("button", { name: "Request actions" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Report request…" }));
  expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Spam" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Spam" }));
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe(alreadyReported ? "You already reported this request." : "Thanks — a moderator will take a look."));
  expect(h.apiCall).toHaveBeenCalledWith(expect.any(Function), "/v1/reviews/request/report", { method: "POST", body: JSON.stringify({ reason: "Spam" }), signal: expect.any(AbortSignal) });
});

it("hides request reporting for signed-out readers and recovers a report failure with readable feedback", async () => {
  const data = fixture(); data.request.asker.isYou = false; h.signedIn = false;
  const { rerender } = render(<RequestHeader data={data} onChanged={h.changed} />);
  expect(screen.queryByRole("button", { name: "Request actions" })).toBeNull();
  h.signedIn = true; h.apiCall.mockRejectedValue({ message: "Report service unavailable." }); rerender(<RequestHeader data={data} onChanged={h.changed} />);
  fireEvent.click(screen.getByRole("button", { name: "Request actions" })); fireEvent.click(screen.getByRole("menuitem", { name: "Report request…" })); fireEvent.click(screen.getByRole("menuitem", { name: "Other" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Report service unavailable.");
});
