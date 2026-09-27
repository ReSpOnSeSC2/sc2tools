import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getJsonWithStatus: vi.fn() }));

vi.mock("@/lib/serverApi", () => ({
  getJsonWithStatus: (...args: unknown[]) => mocks.getJsonWithStatus(...args),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw Object.assign(new Error("NEXT_NOT_FOUND"), { digest: "NEXT_NOT_FOUND" });
  },
}));
vi.mock("@/components/reviews/ReviewPage", () => ({ ReviewPage: () => null }));
vi.mock("@/components/reviews/ReviewPageLoader", () => ({ ReviewPageLoader: () => null }));

import ReviewRoute, { generateMetadata } from "./page";
import { serializeJsonLd, reviewJsonLd } from "@/lib/reviewJsonLd";
import type { ReviewPageData } from "@/lib/reviews";

const ID = "AAAAAAAAAAAAAAAA";

function pageData(overrides: Partial<ReviewPageData["seo"]> = {}): ReviewPageData {
  return {
    request: {
      id: ID, url: `/reviews/${ID}`, question: "Why did my blink all-in fail </script><script>alert(1)</script>?",
      tags: [], timeRange: null, desiredLevel: "anyone", visibility: "public", status: "answered", closedReason: null, hidden: false,
      asker: { label: "Anonymous Protoss", anonymous: true, band: { id: 4, label: "Diamond" }, mmr: 4100, isYou: false },
      game: { matchup: "PvZ", myRace: "Protoss", oppRace: "Zerg", map: "Alcyone LE", result: "Loss", durationSec: 640, myBuild: null, oppStrategy: null, macroScore: null, hasPlayback: true },
      opponent: { label: "Opponent (Zerg, ~4,100 MMR)", race: "Zerg", band: null, mmr: 4100 },
      stats: { reviewCount: 2, commentCount: 2, helpfulCount: 1, upvoteTotal: 3 },
      bestCommentId: "BBBBBBBBBBBBBBBB", createdAt: "2026-09-27T10:00:00.000Z", lastActivityAt: null,
    },
    comments: [
      { id: "BBBBBBBBBBBBBBBB", parentId: null, state: "visible", author: { label: "CoachFox", isAsker: false, profileHref: null, verified: null, badges: [], flair: null, coach: null }, body: "Scout at 4:30.", gameTimeSec: 270, endTimeSec: null, mapPoint: null, upvotes: 3, upvoted: false, helpful: false, best: true, mine: false, canEdit: false, createdAt: "2026-09-27T11:00:00.000Z", editedAt: null },
      { id: "CCCCCCCCCCCCCCCC", parentId: null, state: "visible", author: { label: "Other", isAsker: false, profileHref: null, verified: null, badges: [], flair: null, coach: null }, body: "Probe count stalled.", gameTimeSec: 300, endTimeSec: null, mapPoint: null, upvotes: 0, upvoted: false, helpful: true, best: false, mine: false, canEdit: false, createdAt: "2026-09-27T12:00:00.000Z", editedAt: null },
    ],
    viewer: { signedIn: false, isAsker: false, isAdmin: false, canComment: false, reason: "sign_in" },
    seo: { indexable: true, answerCount: 2, acceptedAnswerId: "BBBBBBBBBBBBBBBB", suggestedAnswerIds: ["CCCCCCCCCCCCCCCC"], ...overrides },
  };
}

beforeEach(() => vi.stubEnv("NEXT_PUBLIC_REVIEWS_ENABLED", "on"));
afterEach(() => {
  vi.unstubAllEnvs();
  mocks.getJsonWithStatus.mockReset();
});

describe("/reviews/[id] SEO", () => {
  it("is noindex until the quality gate opens, then indexable with a canonical title", async () => {
    mocks.getJsonWithStatus.mockResolvedValue({ data: pageData({ indexable: false }), status: 200 });
    const gated = await generateMetadata({ params: Promise.resolve({ id: ID }) });
    expect(gated.robots).toEqual({ index: false, follow: true });
    mocks.getJsonWithStatus.mockResolvedValue({ data: pageData(), status: 200 });
    const open = await generateMetadata({ params: Promise.resolve({ id: ID }) });
    expect(open.robots).toEqual({ index: true, follow: true });
    expect(open.alternates?.canonical).toBe(`/reviews/${ID}`);
    expect(String(open.title)).toMatch(/^\[PvZ\] Why did my blink all-in fail .* — Replay Review · SC2 Tools$/);
  });

  it("404s a missing review but degrades (noindex) when the API is down; off rollout 404s", async () => {
    mocks.getJsonWithStatus.mockResolvedValue({ data: null, status: 404 });
    await expect(generateMetadata({ params: Promise.resolve({ id: ID }) })).rejects.toThrow("NEXT_NOT_FOUND");
    mocks.getJsonWithStatus.mockResolvedValue({ data: null, status: null });
    const down = await generateMetadata({ params: Promise.resolve({ id: ID }) });
    expect(down.robots).toEqual({ index: false, follow: false });
    vi.stubEnv("NEXT_PUBLIC_REVIEWS_ENABLED", "");
    await expect(generateMetadata({ params: Promise.resolve({ id: ID }) })).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("emits valid QAPage + BreadcrumbList JSON-LD with user text escaped", async () => {
    mocks.getJsonWithStatus.mockResolvedValue({ data: pageData(), status: 200 });
    const ui = (await ReviewRoute({ params: Promise.resolve({ id: ID }) })) as { props: { children: Array<{ props?: { dangerouslySetInnerHTML?: { __html: string } } }> } };
    const script = ui.props.children[0];
    const html = script.props?.dangerouslySetInnerHTML?.__html ?? "";
    expect(html).not.toContain("</script>");
    const [qa, crumbs] = JSON.parse(html);
    expect(qa["@type"]).toBe("QAPage");
    expect(qa.mainEntity).toMatchObject({ "@type": "Question", answerCount: 2 });
    expect(qa.mainEntity.acceptedAnswer).toMatchObject({ "@type": "Answer", text: "Scout at 4:30.", upvoteCount: 3 });
    expect(qa.mainEntity.suggestedAnswer).toHaveLength(1);
    expect(crumbs["@type"]).toBe("BreadcrumbList");
    expect(crumbs.itemListElement[0].item).toMatch(/\/reviews$/);

    mocks.getJsonWithStatus.mockResolvedValue({ data: pageData({ indexable: false }), status: 200 });
    const gated = (await ReviewRoute({ params: Promise.resolve({ id: ID }) })) as { props: { children: unknown[] } };
    expect(gated.props.children[0]).toBeNull();
  });

  it("serializes without a script break-out", () => {
    const text = serializeJsonLd(reviewJsonLd(pageData(), "https://sc2tools.com"));
    expect(text).not.toMatch(/<|>/);
    expect(JSON.parse(text)[0].mainEntity.text).toContain("</script>");
  });
});
