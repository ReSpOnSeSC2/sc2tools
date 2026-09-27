import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: async () => "token", isSignedIn: true, isLoaded: true, userId: "viewer" }),
}));
vi.mock("@/lib/clientApi", () => ({ apiCall: vi.fn(async () => ({})) }));
vi.mock("@/lib/analytics/gtag", () => ({ gaEvent: vi.fn() }));

import { ReviewThread } from "../ReviewThread";
import type { ReviewComment, ReviewPageData } from "@/lib/reviews";

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

afterEach(() => cleanup());

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
        draftPin={null}
        pinMode={false}
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
