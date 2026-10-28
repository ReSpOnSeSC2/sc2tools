import { beforeEach, expect, it, vi } from "vitest";
import type { PublicReplayDetailResponse } from "@/components/analyzer/replays/types";
import type { ApiResult } from "@/lib/api";

const h = vi.hoisted(() => ({ fetch: vi.fn(), notFound: vi.fn(), redirect: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiFetch: h.fetch }));
vi.mock("next/navigation", () => ({ notFound: h.notFound, redirect: h.redirect }));
vi.mock("../SharedReplayAnalysisContent", () => ({ SharedReplayAnalysisContent: () => null }));
import Page, { generateMetadata } from "@/app/players/[player]/replays/[gameId]/page";
import { SharedReplayAnalysisContent } from "../SharedReplayAnalysisContent";
import { PublicUnavailable } from "../PublicUnavailable";

const props = () => ({ params: Promise.resolve({ player: "shared-owner", gameId: "replay" }) });
const success = (): Extract<ApiResult<PublicReplayDetailResponse>, { ok: true }> => ({ ok: true, status: 200, data: { profile: { handle: "shared-owner" }, game: { gameId: "replay" } } as PublicReplayDetailResponse });
beforeEach(() => {
  vi.clearAllMocks();
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
