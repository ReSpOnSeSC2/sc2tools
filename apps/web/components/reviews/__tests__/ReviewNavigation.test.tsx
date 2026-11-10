import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewComment, ReviewPageData } from "@/lib/reviews";

const h = vi.hoisted(() => ({
  page: null as ReviewPageData | null,
  seeks: [] as Array<{ t: number; seq: number } | null>,
  info: vi.fn(), success: vi.fn(), gaEvent: vi.fn(), writeText: vi.fn(),
}));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: true, userId: "viewer", getToken: async () => "token" }) }));
vi.mock("@/lib/clientApi", async (original) => ({ ...await original<typeof import("@/lib/clientApi")>(), apiCall: vi.fn(async () => ({})) }));
vi.mock("@/lib/usePublicApi", () => ({ usePublicApi: (path: string | null) => ({
  data: path && !path.endsWith("analysis") ? h.page : undefined, mutate: vi.fn(async () => undefined), isValidating: false, error: undefined }) }));
vi.mock("@/components/maps/MapArtwork", () => ({ MapArtwork: () => null }));
vi.mock("@/lib/analytics/gtag", () => ({ gaEvent: h.gaEvent }));
vi.mock("@/components/ui/Toast", async (original) => ({
  ...await original<typeof import("@/components/ui/Toast")>(),
  useToastOptional: () => ({ toast: { info: h.info, success: h.success } }),
}));
vi.mock("../ReviewReplayPanel", () => ({
  ReviewReplayPanel: ({ seekRequest, onPlaybackAvailable }: { seekRequest: { t: number; seq: number } | null; onPlaybackAvailable: (value: boolean) => void }) => {
    h.seeks.push(seekRequest);
    return <div data-replay-stage="" aria-label="Map replay"><button type="button" onClick={() => onPlaybackAvailable(true)}>Playback ready</button></div>;
  },
}));

import { ReviewPage } from "../ReviewPage";
import { ReviewThread } from "../ReviewThread";

const ID = "AAAAAAAAAAAAAAAA";
const lastSeek = () => h.seeks.filter(Boolean).at(-1) ?? null;

function comment(id: string, label: string, extra: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id, parentId: null, state: "visible",
    author: { label, isAsker: false, profileHref: null, verified: null, badges: [], flair: null },
    body: `${label} explains what to change here.`, gameTimeSec: 120, endTimeSec: null, mapPoint: null,
    upvotes: 0, upvoted: false, helpful: false, best: false, mine: false, canEdit: false,
    createdAt: "2026-10-01T10:00:00.000Z", editedAt: null, ...extra,
  };
}

function fixture(): ReviewPageData {
  return {
    request: {
      id: ID, url: `/reviews/${ID}`, question: "How should I hold this roach timing?", tags: [], timeRange: { startSec: 180, endSec: 240 },
      desiredLevel: "anyone", visibility: "public", status: "open", closedReason: null, hidden: false,
      asker: { label: "Asker", anonymous: true, band: null, mmr: null, isYou: false },
      game: { matchup: "PvZ", myRace: "Protoss", oppRace: "Zerg", map: "Alcyone LE", result: "Loss", durationSec: 640, myBuild: null, oppStrategy: null, macroScore: null, hasPlayback: true },
      opponent: { label: "Opponent", race: "Zerg", band: null, mmr: null },
      stats: { reviewCount: 2, commentCount: 4, helpfulCount: 0, upvoteTotal: 0 }, bestCommentId: null, createdAt: null, lastActivityAt: null,
    },
    comments: [
      comment("BBBBBBBBBBBBBBBB", "Reviewer", { mapPoint: { x: 10, y: 20 } }),
      comment("CCCCCCCCCCCCCCCC", "Second", { gameTimeSec: 200, createdAt: "2026-10-01T11:00:00.000Z" }),
      comment("DDDDDDDDDDDDDDDD", "Replier", { parentId: "BBBBBBBBBBBBBBBB", gameTimeSec: 300, createdAt: "2026-10-01T12:00:00.000Z" }),
      comment("EEEEEEEEEEEEEEEE", "Gone", { state: "deleted", author: null, gameTimeSec: 400 }),
    ],
    viewer: { signedIn: true, isAsker: false, isAdmin: false, canComment: true, reason: null },
    seo: { indexable: false, answerCount: 2, acceptedAnswerId: null, suggestedAnswerIds: [] },
  };
}

function visit(path: string) { window.history.replaceState(null, "", path); }
const card = (label: string) => screen.getByRole("article", { name: `Comment by ${label}` });
const chip = (label: string) => within(card(label)).getByTestId("review-time-chip");

beforeEach(() => {
  h.page = fixture(); h.seeks = []; h.info.mockReset(); h.success.mockReset(); h.gaEvent.mockReset();
  h.writeText.mockReset(); h.writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText: h.writeText }, configurable: true });
  Element.prototype.scrollIntoView = vi.fn();
  visit(`/reviews/${ID}`);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); window.localStorage.clear(); delete (window as { matchMedia?: unknown }).matchMedia; });

describe("deep links", () => {
  it("selects a linked comment, waits for playback, then seeks and scrolls to it", () => {
    visit(`/reviews/${ID}#comment-CCCCCCCCCCCCCCCC`);
    render(<ReviewPage initial={h.page!} />);
    expect(chip("Second").getAttribute("aria-pressed")).toBe("true");
    expect(lastSeek()).toBeNull();
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Playback ready" }));
    expect(lastSeek()).toMatchObject({ t: 200 });
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
    expect(vi.mocked(Element.prototype.scrollIntoView).mock.contexts[0]).toBe(card("Second"));
    expect(window.location.hash).toBe("#comment-CCCCCCCCCCCCCCCC");
  });

  it("opens ?t= at that moment, clamped to the game, with the composer started there", () => {
    h.page!.request.game.hasPlayback = false;
    visit(`/reviews/${ID}?t=5:12`);
    const view = render(<ReviewPage initial={h.page!} />);
    expect(lastSeek()).toMatchObject({ t: 312 });
    expect(screen.getByTestId("composer-time").textContent).toContain("at 5:12");
    view.unmount(); h.seeks = [];
    visit(`/reviews/${ID}?t=25:00`);
    render(<ReviewPage initial={h.page!} />);
    expect(lastSeek()).toMatchObject({ t: 640 });
  });

  it("reports an unknown or deleted comment and stays put", () => {
    visit(`/reviews/${ID}#comment-EEEEEEEEEEEEEEEE`);
    const view = render(<ReviewPage initial={h.page!} />);
    expect(h.info).toHaveBeenCalledWith("That comment is no longer available");
    expect(document.getElementById("comment-EEEEEEEEEEEEEEEE")).toBeNull();
    view.unmount();
    visit(`/reviews/${ID}#comment-ZZZZZZZZZZZZZZZZ`);
    render(<ReviewPage initial={h.page!} />);
    expect(h.info).toHaveBeenCalledTimes(2);
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
    expect(lastSeek()).toBeNull();
  });

  it("follows a later #comment hash change and scrolls without motion when reduced motion is on", () => {
    window.matchMedia = vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })) as unknown as typeof window.matchMedia;
    h.page!.request.game.hasPlayback = false;
    render(<ReviewPage initial={h.page!} />);
    act(() => { visit(`/reviews/${ID}#comment-BBBBBBBBBBBBBBBB`); window.dispatchEvent(new HashChangeEvent("hashchange")); });
    expect(chip("Reviewer").getAttribute("aria-pressed")).toBe("true");
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ behavior: "auto", block: "start" });
    // Without map playback the replay doesn't follow a linked comment.
    expect(lastSeek()).toBeNull();
  });
});

describe("copy links", () => {
  it("copies a comment link for anyone, without touching the address bar", async () => {
    render(<ReviewPage initial={h.page!} />);
    fireEvent.click(chip("Second"));
    expect(window.location.href).toBe(`${window.location.origin}/reviews/${ID}`);
    fireEvent.click(within(card("Reviewer")).getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy link to comment" }));
    await waitFor(() => expect(h.writeText).toHaveBeenCalledWith(`${window.location.origin}/reviews/${ID}#comment-BBBBBBBBBBBBBBBB`));
    await waitFor(() => expect(h.gaEvent).toHaveBeenCalledWith("review_shared", { channel: "comment_link" }));
    expect(h.success).toHaveBeenCalledWith("Link copied");
  });

  it("copies the composer moment and the current replay time from Share", async () => {
    render(<ReviewPage initial={h.page!} />);
    fireEvent.click(screen.getByRole("button", { name: "Share this review" }));
    const first = await screen.findByRole("menu");
    expect(within(first).getByRole("menuitem", { name: "Copy link" })).toBeTruthy();
    expect(within(first).queryByRole("menuitem", { name: /Copy link at current time/ })).toBeNull();
    fireEvent.keyDown(first, { key: "Escape" });
    fireEvent.click(chip("Second"));
    fireEvent.click(screen.getByRole("button", { name: "Share this review" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Copy link at current time (3:20)" }));
    await waitFor(() => expect(h.writeText).toHaveBeenLastCalledWith(`${window.location.origin}/reviews/${ID}?t=3:20`));
    expect(h.gaEvent).toHaveBeenCalledWith("review_shared", { channel: "moment_link" });
    fireEvent.click(screen.getByRole("button", { name: "Comment at 3:20" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy link at 3:20" }));
    await waitFor(() => expect(h.writeText).toHaveBeenCalledTimes(2));
    expect(h.writeText).toHaveBeenLastCalledWith(`${window.location.origin}/reviews/${ID}?t=3:20`);
    expect(window.location.search).toBe("");
  });
});

describe("keyboard shortcuts", () => {
  const stepper = () => screen.getByTestId("review-stepper");

  it("steps with N and P outside fields, modifiers, dialogs and the replay stage", () => {
    h.page!.request.game.hasPlayback = false;
    render(<ReviewPage initial={h.page!} />);
    expect(stepper().textContent).toContain("3 timed comments");
    fireEvent.keyDown(document.body, { key: "n" });
    expect(lastSeek()).toMatchObject({ t: 120 });
    expect(stepper().querySelector("[aria-live]")?.textContent).toBe("Comment 1 of 3 at 2:00 by Reviewer");
    fireEvent.keyDown(document.body, { key: "N", shiftKey: true });
    fireEvent.keyDown(document.body, { key: "n", ctrlKey: true });
    fireEvent.keyDown(screen.getByLabelText("Map replay"), { key: "n" });
    const dialog = document.body.appendChild(Object.assign(document.createElement("div"), { role: "dialog" }));
    dialog.setAttribute("role", "dialog");
    fireEvent.keyDown(document.body, { key: "n" });
    dialog.remove();
    expect(lastSeek()).toMatchObject({ t: 120 });
    fireEvent.keyDown(document.body, { key: "n" });
    expect(lastSeek()).toMatchObject({ t: 200 });
    expect(within(stepper()).getByText("2 of 3")).toBeTruthy();
    fireEvent.keyDown(document.body, { key: "p" });
    expect(lastSeek()).toMatchObject({ t: 120 });
    expect(within(stepper()).getByRole("button", { name: /Prev/ }).hasAttribute("disabled")).toBe(true);
  });

  it("opens the composer at the replay time with C and ignores keys typed in it", () => {
    render(<ReviewPage initial={h.page!} />);
    fireEvent.click(chip("Second"));
    fireEvent.keyDown(document.body, { key: "c" });
    const box = screen.getByRole("textbox", { name: "Comment" });
    expect(document.activeElement).toBe(box);
    expect(screen.getByTestId("composer-time").textContent).toContain("at 3:20");
    const before = lastSeek();
    fireEvent.keyDown(box, { key: "n" });
    expect(lastSeek()).toBe(before);
  });
});

function renderThread(data = fixture()) {
  return render(<ReviewThread data={data} pinNumbers={new Map()} activeId={null} currentTime={0} durationSec={640} canPin={false}
    pinFor={() => null} pickingFor={null} onSeek={() => {}} onTogglePinMode={() => {}} onClearPin={() => {}} onChanged={() => {}} />);
}

describe("thread filters and order", () => {
  it("combines chips with AND, shows their counts and clears an empty result", () => {
    renderThread();
    const focus = screen.getByRole("button", { name: "In focus range 1" });
    expect(screen.getByRole("button", { name: "Map pins 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Has replies 1" })).toBeTruthy();
    fireEvent.click(focus);
    expect(focus.getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("article", { name: "Comment by Reviewer" })).toBeNull();
    expect(screen.getByRole("article", { name: "Comment by Second" })).toBeTruthy();
    expect(screen.queryByTestId("review-stepper")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Map pins 1" }));
    expect(screen.getByText(/No comments match these filters/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.getByRole("article", { name: "Comment by Reviewer" })).toBeTruthy();
    expect(screen.getByTestId("review-stepper")).toBeTruthy();
  });

  it("keeps a reply's thread when only the reply matches", () => {
    const data = fixture();
    data.comments[0].mapPoint = null;
    data.comments[2].mapPoint = { x: 1, y: 1 };
    renderThread(data);
    fireEvent.click(screen.getByRole("button", { name: "Map pins 1" }));
    expect(screen.getByRole("article", { name: "Comment by Reviewer" })).toBeTruthy();
    expect(screen.getByRole("article", { name: "Comment by Replier" })).toBeTruthy();
    expect(screen.queryByRole("article", { name: "Comment by Second" })).toBeNull();
  });

  it("remembers Timeline order across visits and survives blocked storage", () => {
    const view = renderThread();
    fireEvent.click(screen.getByRole("button", { name: "Timeline" }));
    expect(window.localStorage.getItem("sc2tools:reviews:thread-order")).toBe("timeline");
    view.unmount();
    renderThread();
    expect(screen.getByRole("button", { name: "Timeline" }).getAttribute("aria-pressed")).toBe("true");
    cleanup();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    renderThread();
    expect(screen.getByRole("button", { name: "Top" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Timeline" }));
    expect(screen.getByRole("button", { name: "Timeline" }).getAttribute("aria-pressed")).toBe("true");
  });
});
