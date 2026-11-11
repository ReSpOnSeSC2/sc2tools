import { beforeEach, expect, it, vi } from "vitest";
import type { PublicReplayDetailResponse } from "@/components/analyzer/replays/types";
import type { ApiResult } from "@/lib/api";

const h = vi.hoisted(() => ({ fetch: vi.fn(), card: vi.fn(), auth: vi.fn(), notFound: vi.fn(), redirect: vi.fn() }));
vi.mock("@clerk/nextjs/server", () => ({ auth: h.auth }));
vi.mock("@/lib/publicReplayCard", () => ({ readPublicReplayCard: h.card }));
vi.mock("@/lib/api", () => ({ apiFetch: h.fetch }));
vi.mock("next/navigation", () => ({ notFound: h.notFound, redirect: h.redirect }));
vi.mock("../SharedReplayAnalysisContent", () => ({ SharedReplayAnalysisContent: () => null }));
import Page, { generateMetadata } from "@/app/players/[player]/replays/[gameId]/page";
import { SharedReplayAnalysisContent } from "../SharedReplayAnalysisContent";
import { PublicUnavailable } from "../PublicUnavailable";
import { SharedAnalysisTeaser } from "../SharedAnalysisTeaser";

const REFERENCE = "r-0123456789abcdef01234567";
const props = (gameId = "replay") => ({ params: Promise.resolve({ player: "shared-owner", gameId }) });
const success = (): Extract<ApiResult<PublicReplayDetailResponse>, { ok: true }> => ({ ok: true, status: 200, data: { profile: { handle: "shared-owner" }, game: { gameId: "replay" } } as PublicReplayDetailResponse });
beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue({ userId: "viewer" });
  h.notFound.mockImplementation(() => { throw new Error("not_found"); });
  h.redirect.mockImplementation(() => { throw new Error("canonical_redirect"); });
});

it("does not return an analysis island while authoritative access is unresolved", async () => {
  let release!: (result: ApiResult<PublicReplayDetailResponse>) => void;
  h.fetch.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  let settled = false;
  const pending = Page(props()).then(node => { settled = true; return node; });
  await vi.waitFor(() => expect(h.fetch).toHaveBeenCalledOnce());
  expect(settled).toBe(false);
  release(success());
  const node = await pending;
  expect(node.type).toBe(SharedReplayAnalysisContent);
  expect(node.props.data.game.gameId).toBe("replay");
});

it("keeps page and metadata 404 decisions authoritative before any analysis output", async () => {
  h.fetch.mockResolvedValue({ ok: false, status: 404, error: "not_found" });
  await expect(Page(props())).rejects.toThrow("not_found");
  await expect(generateMetadata(props())).rejects.toThrow("not_found");
  expect(h.notFound).toHaveBeenCalledTimes(2);
});

it.each([401, 429, 500, 0])("keeps API%s failures out of the analysis island", async status => {
  h.fetch.mockResolvedValue({ ok: false, status, error: "unavailable" });
  const node = await Page(props());
  expect(node.type).toBe(PublicUnavailable);
  expect(node.props.reason).toBe(status === 429 ? "busy" : "outage");
});

it("resolves the canonical owner redirect before mounting the analysis island", async () => {
  const result = success(); result.data.profile.handle = "canonical-owner";
  h.fetch.mockResolvedValue(result);
  await expect(Page(props())).rejects.toThrow("canonical_redirect");
  expect(h.redirect).toHaveBeenCalledWith("/players/canonical-owner/replays/replay");
});

it("serves the public opaque card teaser without loading signed-in analysis", async () => {
  h.auth.mockResolvedValue({ userId: null });
  const card = { profile: { handle: "shared-owner", displayName: "Reaver" }, game: { result: "Victory", matchup: "PvZ", map: "Alcyone" } };
  h.card.mockResolvedValue({ data: card, status: 200 });
  const node = await Page(props(REFERENCE));
  expect(node.type).toBe(SharedAnalysisTeaser);
  expect(node.props.card).toBe(card);
  const md = await generateMetadata(props(REFERENCE));
  expect(md.title).toBe("Win · PvZ on Alcyone — Reaver's replay");
  expect(md.alternates?.canonical).toBe("/players/shared-owner/replays/" + REFERENCE);
  expect(md.robots).toEqual({ index: false, follow: false });
  expect(h.fetch).not.toHaveBeenCalled();
  h.card.mockResolvedValue({ data: null, status: 404 });
  await expect(Page(props(REFERENCE))).rejects.toThrow("not_found");
});

it("redirects a signed-in legacy path to its opaque reference", async () => {
  const result = success();
  result.data.game.gameId = REFERENCE;
  h.fetch.mockResolvedValue(result);
  await expect(Page(props())).rejects.toThrow("canonical_redirect");
  expect(h.redirect).toHaveBeenCalledWith("/players/shared-owner/replays/" + REFERENCE);
});
