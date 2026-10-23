import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReplayLibraryItem, ReplayLibraryResponse } from "@/components/analyzer/replays/types";
import type { ReviewBoardResponse, ReviewerMe } from "@/lib/reviews";

const h = vi.hoisted(() => ({
  signedIn: true, loaded: true, userId: "user-one", admin: false,
  pages: new Map<string, Partial<ReplayLibraryResponse>>(), error: undefined as unknown,
  help: undefined as (ReviewBoardResponse & { verified: ReviewerMe["verified"]; reason: string | null }) | undefined,
  helpError: undefined as unknown, paths: [] as string[], retry: vi.fn(), board: undefined as ReviewBoardResponse | undefined,
}));
vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ isLoaded: h.loaded, isSignedIn: h.signedIn, userId: h.userId }),
  SignedIn: ({ children }: { children: ReactNode }) => h.signedIn ? children : null,
}));
vi.mock("@/lib/clientApi", () => ({ apiCall: vi.fn(), useApi: (path: string | null) => {
  if (path === "/v1/reviews/for-me") return { data: h.help, error: h.helpError, mutate: h.retry };
  if (path === "/v1/me") return { data: { isAdmin: h.admin } };
  if (path) h.paths.push(path);
  return { data: path ? h.pages.get(path) : undefined, error: h.error, mutate: h.retry, isLoading: false, isValidating: false };
} }));
vi.mock("@/lib/usePublicApi", () => ({ usePublicApi: (path: string) => { h.paths.push(path); return { data: h.board }; } }));
vi.mock("../AskForReviewButton", () => ({ AskForReviewDialog: ({ gameId, durationSec, matchup, onClose }: { gameId: string; durationSec: number; matchup: string; onClose: () => void }) => <div role="dialog" aria-label="Ask for a review">{gameId} · {durationSec} · {matchup}<button onClick={onClose}>Cancel request</button></div> }));
vi.mock("../ReviewReplayDownload", () => ({ ReviewReplayDownload: () => <button>Download replay</button> }));

import { AskAboutGameButton, AskGamePicker } from "../AskGamePicker";
import { HelpWithPanel } from "../ReviewBoardSidebar";
import { ReviewBoardEmpty } from "../ReviewBoardEmpty";
import { ReviewBoardLoader } from "../ReviewBoardLoader";
import { parseBoardFilters } from "@/lib/reviews";

const firstPath = "/v1/replays?limit=20&sort=date_desc";
const game = (id: string, extra: Partial<ReplayLibraryItem> = {}): ReplayLibraryItem => ({ gameId: id, map: id, durationSec: 640, matchup: "PvZ", date: "2026-10-01T12:00:00Z", result: "Win", matchFormat: "1v1", ...extra });
const page = (items: ReplayLibraryItem[], nextCursor: string | null = null) => ({ items, page: { hasMore: !!nextCursor, nextCursor } });

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_REVIEWS_ENABLED", "on");
  h.signedIn = true; h.loaded = true; h.userId = "user-one"; h.admin = false;
  h.pages.clear(); h.paths = []; h.error = undefined; h.help = undefined; h.helpError = undefined; h.board = undefined;
  h.retry.mockReset(); h.retry.mockResolvedValue(undefined); localStorage.clear();
});
afterEach(() => { cleanup(); vi.unstubAllEnvs(); vi.useRealTimers(); vi.restoreAllMocks(); });

it("gates the ask CTA by authentication and rollout, including admin preview", () => {
  const { rerender } = render(<AskAboutGameButton />);
  expect(screen.getByRole("button", { name: "Ask about one of your games" })).toBeTruthy();
  h.signedIn = false; rerender(<AskAboutGameButton />);
  expect(screen.queryByRole("button")).toBeNull();
  h.signedIn = true; h.loaded = false; rerender(<AskAboutGameButton />);
  expect(screen.queryByRole("button")).toBeNull();
  h.loaded = true; vi.stubEnv("NEXT_PUBLIC_REVIEWS_ENABLED", "admins"); rerender(<AskAboutGameButton />);
  expect(screen.queryByRole("button")).toBeNull();
  h.admin = true; rerender(<AskAboutGameButton />);
  expect(screen.getByRole("button")).toBeTruthy();
  vi.stubEnv("NEXT_PUBLIC_REVIEWS_ENABLED", "off"); rerender(<AskAboutGameButton />);
  expect(screen.queryByRole("button")).toBeNull();
});

it("offers only reviewable games and opens the selected game's existing request dialog in place", () => {
  h.pages.set(firstPath, page([game("Alcyone"), game("Team map", { matchFormat: "team", playerCount: 4 })]));
  const { rerender } = render(<AskAboutGameButton />);
  fireEvent.click(screen.getByRole("button", { name: "Ask about one of your games" }));
  expect(screen.getByRole("dialog", { name: "Pick a game to ask about" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Team map/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Alcyone/ }));
  expect(screen.queryByRole("dialog", { name: "Pick a game to ask about" })).toBeNull();
  expect(screen.getByRole("dialog", { name: "Ask for a review" }).textContent).toContain("Alcyone · 640 · PvZ");
  h.userId = "user-two"; rerender(<AskAboutGameButton />);
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("accumulates additional pages without duplicates and resets both games and cursor on debounced search", async () => {
  vi.useFakeTimers();
  h.pages.set(firstPath, page([game("Alcyone")], "two"));
  h.pages.set(`${firstPath}&cursor=two`, page([game("Alcyone"), game("Oceanborn")], null));
  h.pages.set(`${firstPath}&search=Gold`, page([game("Goldenaura")], null));
  render(<AskGamePicker onClose={vi.fn()} onChoose={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Load more" }));
  expect(screen.getAllByRole("button", { name: /Choose game/ })).toHaveLength(2);
  fireEvent.change(screen.getByRole("searchbox", { name: "Search your games" }), { target: { value: "Gold" } });
  await act(async () => vi.advanceTimersByTime(249));
  expect(screen.getByRole("button", { name: /Oceanborn/ })).toBeTruthy();
  await act(async () => vi.advanceTimersByTime(1));
  expect(screen.getByRole("button", { name: /Goldenaura/ })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Oceanborn/ })).toBeNull();
  expect(h.paths).not.toContain(`${firstPath}&search=Gold&cursor=two`);
});

it("distinguishes loading, a recoverable error, no sync and no search matches", async () => {
  const { rerender } = render(<AskGamePicker onClose={vi.fn()} onChoose={vi.fn()} />);
  expect(screen.getByLabelText("Loading your games").getAttribute("aria-busy")).toBe("true");
  h.error = { status: 503 }; rerender(<AskGamePicker onClose={vi.fn()} onChoose={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(h.retry).toHaveBeenCalledOnce());
  expect(screen.queryByText("No synced games yet")).toBeNull();
  h.error = undefined; h.pages.set(firstPath, page([])); rerender(<AskGamePicker onClose={vi.fn()} onChoose={vi.fn()} />);
  expect(screen.getByText("No synced games yet")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Pair a device" }).getAttribute("href")).toBe("/devices");
  expect(screen.getByRole("link", { name: "Get the desktop app" }).getAttribute("href")).toBe("/download");
  h.pages.set(`${firstPath}&search=Nope`, page([]));
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Nope" } });
  expect(await screen.findByText("No 1v1 games match ‘Nope’")).toBeTruthy();
});

it("explains a filtered empty board and keeps the chosen sort when clearing filters", () => {
  const { rerender } = render(<ReviewBoardEmpty filters={parseBoardFilters({ sort: "top", race: "Z" })} />);
  expect(screen.getByText("No requests match these filters")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Clear filters" }).getAttribute("href")).toBe("/reviews?sort=top");
  expect(screen.getByRole("button", { name: "Ask about one of your games" })).toBeTruthy();
  rerender(<ReviewBoardEmpty filters={parseBoardFilters({})} />);
  expect(screen.getByText("No open requests yet")).toBeTruthy();
  expect(screen.queryByRole("link", { name: "Clear filters" })).toBeNull();
});

it("keeps filters and pagination in the authenticated admin board", () => {
  h.board = { items: [], nextCursor: "next" };
  render(<ReviewBoardLoader query="?sort=new&race=P&unanswered=1" cursor="current" />);
  expect(h.paths).toContain("/v1/reviews?sort=new&race=P&unanswered=1&cursor=current");
  expect(screen.getByRole("link", { name: /Newest/ }).getAttribute("href")).toBe("/reviews?sort=new&race=P&unanswered=1");
  expect(screen.getByRole("link", { name: /Older requests/ }).getAttribute("href")).toContain("&cursor=next");
});

it("retries personalised requests without treating a failed request as an empty list", () => {
  const { rerender } = render(<HelpWithPanel placement="aside" now={Date.now()} />);
  expect(screen.getByLabelText("Loading requests for you").children).toHaveLength(3);
  h.helpError = { status: 503 }; rerender(<HelpWithPanel placement="aside" now={Date.now()} />);
  expect(screen.getByRole("alert").textContent).toContain("Couldn't load requests for you");
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(h.retry).toHaveBeenCalledOnce();
  h.helpError = undefined; h.help = { items: [], nextCursor: null, verified: null, reason: "unverified" };
  rerender(<HelpWithPanel placement="aside" now={Date.now()} />);
  expect(screen.getByRole("link", { name: "Get the desktop app" })).toBeTruthy();
});

it("restores the mobile panel preference and links to all unanswered requests for the verified race", async () => {
  localStorage.setItem("sc2tools:reviews:helpwith-open", "true");
  h.help = { items: [], nextCursor: null, reason: null, verified: { race: "Protoss" } as ReviewerMe["verified"] };
  const { container, unmount } = render(<HelpWithPanel placement="inline" now={Date.now()} />);
  const details = container.querySelector("details")!;
  expect(details.open).toBe(true);
  expect(screen.getByRole("link", { name: "See all Protoss requests →" }).getAttribute("href")).toBe("/reviews?race=P&unanswered=1");
  details.open = false; fireEvent(details, new Event("toggle"));
  await waitFor(() => expect(localStorage.getItem("sc2tools:reviews:helpwith-open")).toBe("false"));
  unmount();
  const next = render(<HelpWithPanel placement="inline" now={Date.now()} />);
  expect(next.container.querySelector("details")?.open).toBe(false);
});
