import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: async () => "token", isSignedIn: true, isLoaded: true, userId: "viewer" }),
}));
vi.mock("@/lib/clientApi", () => ({ apiCall: vi.fn(async () => ({})) }));
vi.mock("@/lib/analytics/gtag", () => ({ gaEvent: vi.fn() }));

import { ReviewThread } from "../ReviewThread";
import type { ReviewComment, ReviewPageData } from "@/lib/reviews";
import { apiCall } from "@/lib/clientApi";

const ID = "AAAAAAAAAAAAAAAA";

function comment(id: string, label: string, isAsker: boolean, extra: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id, parentId: null, state: "visible",
    author: { label, isAsker, profileHref: null, verified: null, badges: [], flair: null },
    body: `${label} says something useful here.`, gameTimeSec: 120, endTimeSec: null, mapPoint: null,
    upvotes: 2, upvoted: false, helpful: false, best: false, mine: false, canEdit: false,
    createdAt: "2026-09-27T11:00:00.000Z", editedAt: null, ...extra,
  };
}

function data(): ReviewPageData {
  return {
    request: {
      id: ID, url: `/reviews/${ID}`, question: "Why did my blink all-in fail against roaches?",
      tags: [], timeRange: null, desiredLevel: "anyone", visibility: "public", status: "open", closedReason: null, hidden: false,
      asker: { label: "Anonymous Protoss", anonymous: true, band: null, mmr: null, isYou: false },
      game: { matchup: "PvZ", myRace: "Protoss", oppRace: "Zerg", map: "Alcyone LE", result: "Loss", durationSec: 640, myBuild: null, oppStrategy: null, macroScore: null, hasPlayback: false },
      opponent: { label: "Opponent (Zerg, ~4,100 MMR)", race: "Zerg", band: null, mmr: 4100 },
      stats: { reviewCount: 1, commentCount: 2, helpfulCount: 0, upvoteTotal: 2 },
      bestCommentId: null, createdAt: "2026-09-27T10:00:00.000Z", lastActivityAt: null,
    },
    comments: [
      comment("BBBBBBBBBBBBBBBB", "ReviewFox", false),
      comment("CCCCCCCCCCCCCCCC", "Anonymous Protoss", true, { parentId: "BBBBBBBBBBBBBBBB" }),
    ],
    viewer: { signedIn: true, isAsker: false, isAdmin: false, canComment: true, reason: null },
    seo: { indexable: false, answerCount: 1, acceptedAnswerId: null, suggestedAnswerIds: [] },
  };
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("review thread: the anonymous asker's replies", () => {
  it("offers no upvote and no Block for the asker (either would tie them to their account)", () => {
    render(
      <ReviewThread
        data={data()}
        pinNumbers={new Map()}
        activeId={null}
        currentTime={0}
        durationSec={640}
        canPin={false}
        pinFor={() => null}
        pickingFor={null}
        onSeek={() => {}}
        onTogglePinMode={() => {}}
        onClearPin={() => {}}
        onChanged={() => {}}
      />,
    );
    const reviewer = screen.getByRole("article", { name: "Comment by ReviewFox" });
    const asker = screen.getByRole("article", { name: "Comment by Anonymous Protoss" });

    expect(within(reviewer).getByRole("button", { name: /Upvote/ })).toBeTruthy();
    expect(within(asker).queryByRole("button", { name: /Upvote/ })).toBeNull();

    fireEvent.click(within(reviewer).getByRole("button", { name: "More actions" }));
    expect(within(reviewer).getByRole("menuitem", { name: "Block reviewer" })).toBeTruthy();
    fireEvent.click(within(asker).getByRole("button", { name: "More actions" }));
    expect(within(asker).getByRole("menuitem", { name: "Report…" })).toBeTruthy();
    expect(within(asker).queryByRole("menuitem", { name: "Block reviewer" })).toBeNull();
  });
});

function renderThread(next = data()) {
  return render(<ReviewThread data={next} pinNumbers={new Map()} activeId={null} currentTime={0} durationSec={640} canPin={false}
    pinFor={() => null} pickingFor={null} onSeek={() => {}} onTogglePinMode={() => {}} onClearPin={() => {}} onChanged={() => {}} />);
}

it("shows relative timestamps, full local titles and only a meaningful edited marker", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-27T14:00:00Z"));
  const next = data(); next.comments[0].editedAt = "2026-09-27T11:02:00Z"; next.comments[1].createdAt = null;
  renderThread(next); const root = screen.getByRole("article", { name: "Comment by ReviewFox" });
  const time = root.querySelector("time")!; expect(time.dateTime).toBe("2026-09-27T11:00:00.000Z"); expect(time.textContent).toBe("3h ago");
  expect(time.title).toBe(new Date(time.dateTime).toLocaleString()); expect(within(root).getByText("· edited").title).toBe(`Edited ${new Date(next.comments[0].editedAt).toLocaleString()}`);
  expect(screen.getByRole("article", { name: "Comment by Anonymous Protoss" }).querySelector("time")).toBeNull();
  await act(async () => vi.advanceTimersByTime(60 * 60_000)); expect(time.textContent).toBe("4h ago");
});

it("explains a repeated comment report using the parsed API response", async () => {
  vi.mocked(apiCall).mockResolvedValueOnce({ alreadyReported: true }); renderThread();
  const root = screen.getByRole("article", { name: "Comment by ReviewFox" });
  fireEvent.click(within(root).getByRole("button", { name: "More actions" })); fireEvent.click(within(root).getByRole("menuitem", { name: "Report…" }));
  fireEvent.click(within(root).getByRole("menuitem", { name: "Spam" }));
  expect((await within(root).findByRole("status")).textContent).toBe("You already reported this comment.");
  expect(apiCall).toHaveBeenLastCalledWith(expect.any(Function), `/v1/reviews/${ID}/comments/BBBBBBBBBBBBBBBB/report`, { method: "POST", body: JSON.stringify({ reason: "Spam" }) });
});

it("uses explicit block and delete confirmations without native browser prompts", async () => {
  const confirm = vi.spyOn(window, "confirm"); vi.mocked(apiCall).mockResolvedValue({});
  const { unmount } = renderThread(); const root = screen.getByRole("article", { name: "Comment by ReviewFox" });
  fireEvent.click(within(root).getByRole("button", { name: "More actions" })); fireEvent.click(within(root).getByRole("menuitem", { name: "Block reviewer" }));
  const block = screen.getByRole("dialog", { name: "Block ReviewFox?" });
  expect(block.textContent).toContain("Undo it in My reviews > Blocked reviewers.");
  fireEvent.click(within(block).getByRole("button", { name: "Block" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull()); unmount();
  const next = data(); next.comments[0].mine = true; renderThread(next);
  fireEvent.click(within(screen.getByRole("article", { name: "Comment by ReviewFox" })).getByRole("button", { name: "Delete" }));
  const remove = screen.getByRole("dialog", { name: "Delete this comment?" }); expect(remove.textContent).toContain("It's replaced by [deleted] for everyone. Replies stay.");
  fireEvent.click(within(remove).getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(apiCall).toHaveBeenLastCalledWith(expect.any(Function), `/v1/reviews/${ID}/comments/BBBBBBBBBBBBBBBB`, { method: "DELETE", body: undefined }));
  expect(confirm).not.toHaveBeenCalled();
});

it("retains edit text when the API rejects the edit and keeps its error visible", async () => {
  vi.mocked(apiCall).mockRejectedValueOnce({ message: "The 15-minute edit window has closed." });
  const next = data(); next.comments[0] = { ...next.comments[0], mine: true, canEdit: true, createdAt: null }; renderThread(next);
  const root = screen.getByRole("article", { name: "Comment by ReviewFox" }); fireEvent.click(within(root).getByRole("button", { name: "Edit" }));
  fireEvent.change(within(root).getByRole("textbox", { name: "Edit comment" }), { target: { value: "Scout their third base before moving out." } });
  fireEvent.click(within(root).getByRole("button", { name: "Save" }));
  expect((await within(root).findByRole("alert")).textContent).toBe("The 15-minute edit window has closed.");
  expect((within(root).getByRole("textbox") as HTMLTextAreaElement).value).toBe("Scout their third base before moving out.");
});
