import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReviewPageData } from "@/lib/reviews";
const h = vi.hoisted(() => ({ auth: { isLoaded: true, isSignedIn: true, userId: "A" as string | null, getToken: vi.fn<() => Promise<string | null>>() }, changed: vi.fn(), closed: vi.fn() }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => h.auth }));
vi.mock("@/lib/analytics/gtag", () => ({ gaEvent: vi.fn() }));
vi.mock("@/components/maps/MapArtwork", () => ({ MapArtwork: () => null }));
vi.mock("../ReviewReplayPanel", () => ({ ReviewReplayPanel: () => null }));
vi.mock("../ReviewShareMenu", () => ({ ReviewShareMenu: () => null }));
import { RequestHeader } from "../ReviewPage";
import { ReviewThread } from "../ReviewThread";

function fixture(asker: boolean): ReviewPageData {
  return { request: { id: "AAAAAAAAAAAAAAAA", url: "/reviews/AAAAAAAAAAAAAAAA", question: "How should I defend this attack?", tags: [], timeRange: null,
    desiredLevel: "anyone", visibility: "public", status: "open", closedReason: null, hidden: false,
    asker: { label: "Asker", anonymous: true, band: null, mmr: null, isYou: asker },
    game: { matchup: "PvZ", myRace: "Protoss", oppRace: "Zerg", map: "Alcyone LE", result: "Loss", durationSec: 640, myBuild: null, oppStrategy: null, macroScore: null, hasPlayback: false },
    opponent: { label: "Opponent", race: "Zerg", band: null, mmr: null }, stats: { reviewCount: 1, commentCount: 1, helpfulCount: 0, upvoteTotal: 0 }, bestCommentId: null,
    createdAt: null, lastActivityAt: null, replay: { shared: false, available: false, optedIn: false } },
    comments: [{ id: "BBBBBBBBBBBBBBBB", parentId: null, state: "visible", author: { label: "Reviewer", isAsker: false, profileHref: null, verified: null, badges: [], flair: null },
      body: "Scout the third base before moving out.", gameTimeSec: 120, endTimeSec: null, mapPoint: null, upvotes: 0, upvoted: false, helpful: false, best: false, mine: false, canEdit: false, createdAt: null, editedAt: null }],
    viewer: { signedIn: true, isAsker: asker, isAdmin: false, canComment: true, reason: null },
    seo: { indexable: false, answerCount: 1, acceptedAnswerId: null, suggestedAnswerIds: [] } };
}
beforeEach(() => { h.auth.userId = "A"; h.auth.isLoaded = true; h.auth.isSignedIn = true; h.auth.getToken.mockReset(); h.changed.mockReset().mockResolvedValue(undefined); h.closed.mockReset(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it.each(["header-report", "header-close", "header-sharing", "comment-upvote", "comment-report"])("never sends a held %s JWT as the next account", async (action) => {
  let finish!: (value: string) => void; h.auth.getToken.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true }))); vi.stubGlobal("fetch", fetcher);
  const data = fixture(action === "header-close" || action === "header-sharing");
  const content = () => action.startsWith("header") ? <RequestHeader data={data} onChanged={h.changed} onClosed={h.closed} /> :
    <ReviewThread data={data} pinNumbers={new Map()} activeId={null} currentTime={0} durationSec={640} canPin={false} pinFor={() => null} pickingFor={null}
      onSeek={() => {}} onTogglePinMode={() => {}} onClearPin={() => {}} onChanged={h.changed} />;
  const view = render(content());
  if (action === "header-report") {
    fireEvent.click(screen.getByRole("button", { name: "Request actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Report request…" })); fireEvent.click(screen.getByRole("menuitem", { name: "Spam" }));
  } else if (action === "header-close") {
    fireEvent.click(screen.getByText("Asker tools")); fireEvent.click(screen.getByRole("button", { name: "Close request" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Close this request?" })).getByRole("button", { name: "Close request" }));
  } else if (action === "header-sharing") {
    fireEvent.click(screen.getByText("Asker tools")); fireEvent.click(screen.getByRole("switch", { name: "Let reviewers download my replay file" }));
  } else if (action === "comment-upvote") fireEvent.click(screen.getByRole("button", { name: /Upvote/ }));
  else {
    fireEvent.click(screen.getByRole("button", { name: "More actions" })); fireEvent.click(screen.getByRole("menuitem", { name: "Report…" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Spam" }));
  }
  await waitFor(() => expect(h.auth.getToken).toHaveBeenCalledOnce());
  h.auth.userId = "B"; view.rerender(content()); await act(async () => finish("B-token"));
  expect(fetcher).not.toHaveBeenCalled(); expect(h.changed).not.toHaveBeenCalled(); expect(h.closed).not.toHaveBeenCalled();
  expect(screen.queryByRole("alert")).toBeNull();
});
