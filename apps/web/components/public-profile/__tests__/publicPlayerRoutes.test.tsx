import { afterEach, describe, expect, it, vi } from "vitest";
import { PublicFetchError } from "@/lib/publicFetchError";
import { PUBLIC_PLAYER, playerEnvelope } from "../__fixtures__/publicPlayer";
const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("react", async actual => ({ ...await actual<typeof import("react")>(), cache: (fn: unknown) => fn }));
vi.mock("@/lib/serverApi", () => ({ getJsonWithStatus: mocks.fetch }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NOT_FOUND"); }, permanentRedirect: (path: string) => { throw new Error(`REDIRECT:${path}`); } }));
vi.mock("@/components/public-profile/PublicPlayerPage", () => ({ PublicPlayerPage: ({ profile }: { profile: { displayName: string } }) => <h1>{profile.displayName}</h1> }));
import PlayerPage, { generateMetadata, dynamic, revalidate } from "@/app/players/[player]/page";
import LegacyProfile from "@/app/p/[handle]/page";
import LegacyReplays from "@/app/p/[handle]/replays/page";
import LegacyReplay from "@/app/p/[handle]/replays/[gameId]/page";
afterEach(() => { mocks.fetch.mockReset(); vi.useRealTimers(); });
describe("fresh public player admission", () => {
  it("reads no-store for page and metadata, with a whole-read signal", async () => {
    mocks.fetch.mockResolvedValue({ data: playerEnvelope(), status: 200 });
    const params = Promise.resolve({ player: PUBLIC_PLAYER.handle });
    await PlayerPage({ params });
    expect((await generateMetadata({ params })).alternates?.canonical).toBe(`/players/${PUBLIC_PLAYER.handle}`);
    expect(dynamic).toBe("force-dynamic"); expect(revalidate).toBe(0);
    expect(mocks.fetch).toHaveBeenCalledWith(`/v1/public/players/${PUBLIC_PLAYER.handle}`, expect.objectContaining({ revalidateSec: 0, signal: expect.any(AbortSignal) }));
  });
  it("uses neutral 404 only for an authoritative 404", async () => {
    mocks.fetch.mockResolvedValue({ data: null, status: 404 });
    await expect(PlayerPage({ params: Promise.resolve({ player: "private" }) })).rejects.toThrow("NOT_FOUND");
    await expect(generateMetadata({ params: Promise.resolve({ player: "private" }) })).rejects.toThrow("NOT_FOUND");
  });
  it.each([null, 429, 500, 503])("throws transient status %s without inventing a missing profile", async status => {
    mocks.fetch.mockResolvedValue({ data: null, status });
    await expect(PlayerPage({ params: Promise.resolve({ player: "requested" }) })).rejects.toBeInstanceOf(PublicFetchError);
  });
  it("treats malformed successful envelopes as temporary failure", async () => {
    mocks.fetch.mockResolvedValue({ data: { profile: { displayName: "Untrusted" } }, status: 200 });
    await expect(generateMetadata({ params: Promise.resolve({ player: "requested" }) })).rejects.toBeInstanceOf(PublicFetchError);
  });
  it("bounds a body/lookup adapter that never settles", async () => {
    vi.useFakeTimers(); mocks.fetch.mockReturnValue(new Promise(() => {}));
    const outcome = PlayerPage({ params: Promise.resolve({ player: "requested" }) });
    const assertion = expect(outcome).rejects.toBeInstanceOf(PublicFetchError);
    await vi.advanceTimersByTimeAsync(8001); await assertion;
  });
  it("takes archive-only visitors directly to replays without exposing Overview", async () => {
    mocks.fetch.mockResolvedValue({ data: { profile: null, archiveOnly: true, handle: PUBLIC_PLAYER.handle, displayName: "Archive player" }, status: 200 });
    await expect(PlayerPage({ params: Promise.resolve({ player: PUBLIC_PLAYER.handle }) })).rejects.toThrow(`REDIRECT:/players/${PUBLIC_PLAYER.handle}/replays`);
    expect((await generateMetadata({ params: Promise.resolve({ player: PUBLIC_PLAYER.handle }) })).robots).toEqual({ index: false, follow: false });
    await expect(LegacyProfile({ params: Promise.resolve({ handle: "legacy-uuid" }) })).rejects.toThrow("NOT_FOUND");
  });
  it("resolves a legacy profile in one permanent hop", async () => {
    mocks.fetch.mockResolvedValue({ data: playerEnvelope(), status: 200 });
    await expect(LegacyProfile({ params: Promise.resolve({ handle: "legacy-uuid" }) })).rejects.toThrow(`REDIRECT:/players/${PUBLIC_PLAYER.handle}`);
  });
  it("resolves legacy replay links once, preserving filters and game identity", async () => {
    mocks.fetch.mockResolvedValue({ data: { profile: { handle: PUBLIC_PLAYER.handle, displayName: PUBLIC_PLAYER.displayName }, items: [], page: { hasMore: false } }, status: 200 });
    await expect(LegacyReplays({ params: Promise.resolve({ handle: "legacy-uuid" }), searchParams: Promise.resolve({ matchup: "PvT", map: "Synthetic LE" }) })).rejects.toThrow(`REDIRECT:/players/${PUBLIC_PLAYER.handle}/replays?matchup=PvT&map=Synthetic+LE`);
    await expect(LegacyReplay({ params: Promise.resolve({ handle: "legacy-uuid", gameId: "game/42" }) })).rejects.toThrow(`REDIRECT:/players/${PUBLIC_PLAYER.handle}/replays/game%2F42`);
    await expect(LegacyReplay({ params: Promise.resolve({ handle: "legacy-uuid", gameId: "game/42" }), searchParams: Promise.resolve({ from: "matchup=PvT&result=loss&private=ignored" }) })).rejects.toThrow(`REDIRECT:/players/${PUBLIC_PLAYER.handle}/replays/game%2F42?from=result%3Dloss%26matchup%3DPvT`);
  });
});
