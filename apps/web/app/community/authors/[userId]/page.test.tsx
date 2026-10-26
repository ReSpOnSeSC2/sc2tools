import { afterEach, describe, expect, it, vi } from "vitest";
import { PublicFetchError } from "@/lib/publicFetchError";
const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/serverApi", () => ({ getJsonWithStatus: mocks.fetch }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NOT_FOUND"); }, permanentRedirect: (path: string) => { throw new Error(`REDIRECT:${path}`); } }));
import LegacyAuthor, { generateMetadata } from "./page";
const params = () => Promise.resolve({ userId: "fixture-user" });
const profile = { handle: "fixture-0123456789", displayName: "Fixture", totals: { games: 0 }, matchups: [], signatureBuilds: [] };
afterEach(() => mocks.fetch.mockReset());
describe("legacy author profile", () => {
  it("redirects once to a canonical public player address", async () => {
    mocks.fetch.mockResolvedValue({ status: 200, data: { handle: profile.handle, displayName: profile.displayName, archiveOnly: false, profile } });
    await expect(LegacyAuthor({ params: params() })).rejects.toThrow("REDIRECT:/players/fixture-0123456789");
    expect((await generateMetadata({ params: params() })).alternates?.canonical).toBe("/players/fixture-0123456789");
  });
  it("gives private/missing accounts the same 404", async () => {
    mocks.fetch.mockResolvedValue({ status: 404, data: null });
    await expect(LegacyAuthor({ params: params() })).rejects.toThrow("NOT_FOUND");
    await expect(generateMetadata({ params: params() })).rejects.toThrow("NOT_FOUND");
  });
  it("does not revive an archive-only profile", async () => {
    mocks.fetch.mockResolvedValue({ status: 200, data: { handle: profile.handle, displayName: "Shared player", archiveOnly: true, profile: null } });
    await expect(LegacyAuthor({ params: params() })).rejects.toThrow("NOT_FOUND");
  });
  it.each([null, 429, 500, 503])("keeps transient status %s distinct from missing", async status => {
    mocks.fetch.mockResolvedValue({ status, data: null });
    await expect(LegacyAuthor({ params: params() })).rejects.toBeInstanceOf(PublicFetchError);
  });
});
