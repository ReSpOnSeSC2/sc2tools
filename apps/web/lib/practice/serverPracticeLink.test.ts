import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadPracticeLink, practiceBuild } from "./serverPracticeLink";

const { link, read } = vi.hoisted(() => ({
  link: { alias: "test-opening", communitySlug: `build-${"a".repeat(32)}`, creator: "Fixture creator", youtubeId: "1234567890_", offsetSec: 12, patchEra: "before" as const, gradeEndSec: 240 },
  read: vi.fn(),
}));
vi.mock("./practiceLinks", () => ({ practiceLinkByAlias: (alias: string) => alias === link.alias ? link : undefined }));
vi.mock("@/lib/serverApi", () => ({ getJsonWithStatus: read }));

const data = { slug: link.communitySlug, title: "An opening", authorName: link.creator, description: "", publishedAt: "2026-01-01", votes: 0,
  build: { buildOrder: { v: 1 as const, source: "game" as const, sourceGameId: "private-game", steps: [] } } };

beforeEach(() => { read.mockReset(); });

describe("Practice Link publication lookup", () => {
  it("does not resolve unlisted or anonymous publications", async () => {
    expect(await loadPracticeLink("arbitrary")).toEqual({ kind: "missing" });
    expect(read).not.toHaveBeenCalled();
    expect(practiceBuild(link, { ...data, authorName: undefined })).toBeNull();
    expect(practiceBuild(link, { ...data, slug: "another-build" })).toBeNull();
  });

  it("freshly reads the allowlisted build and projects public data only", async () => {
    read.mockResolvedValueOnce({ data, status: 200 });
    expect(await loadPracticeLink(link.alias)).toMatchObject({ kind: "ready", build: { title: data.title, order: { v: 1, source: "game", steps: [] } } });
    expect(practiceBuild(link, data)?.order).not.toHaveProperty("sourceGameId");
    expect(read).toHaveBeenLastCalledWith(`/v1/community/builds/${link.communitySlug}`, { revalidateSec: 0, tags: [] });
  });

  it("distinguishes a withdrawn publication from a retryable outage", async () => {
    read.mockResolvedValueOnce({ data: null, status: 404 }).mockResolvedValueOnce({ data: null, status: 503 });
    expect(await loadPracticeLink(link.alias)).toEqual({ kind: "missing" });
    expect(await loadPracticeLink(link.alias)).toEqual({ kind: "unavailable", link });
  });
});
