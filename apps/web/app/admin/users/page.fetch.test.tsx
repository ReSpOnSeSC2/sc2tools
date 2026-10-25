import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SWRConfig } from "swr";
import UsersPage from "./page";
import { navigation, router } from "../components/__tests__/navigationFixture";
vi.mock("next/navigation", () => import("../components/__tests__/navigationFixture"));
const auth = vi.hoisted(() => ({ getToken: vi.fn(async () => "fixture-token"), isLoaded: true, isSignedIn: true, userId: "admin-fixture" }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => auth }));
afterEach(() => { cleanup(); navigation.defer = false; navigation.queued = []; vi.clearAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const row = { userId: "player", clerkUserId: "clerk-player", email: "player@example.test", gameCount: 12, opponentCount: 4, hasAgent: false, agentLastSeenAt: null, lastActivity: null, firstActivity: null };

it("makes one HTTP search request after five keystrokes and retains rows while that request is pending", async () => {
  navigation.url = "/admin/users?debug=1&before=old-cursor";
  let release!: (response: Response) => void;
  const pending = new Promise<Response>(resolve => { release = resolve; });
  const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ items: [row], nextBefore: "next" }))).mockReturnValueOnce(pending);
  vi.stubGlobal("fetch", fetch);
  render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, revalidateOnFocus: false }}><UsersPage /></SWRConfig>);
  expect(await screen.findByRole("table")).toBeTruthy(); expect(fetch).toHaveBeenCalledTimes(1);
  vi.useFakeTimers(); const input = screen.getByRole("textbox", { name: "Search" });
  for (const text of ["p", "pl", "pla", "play", "playe"]) { fireEvent.change(input, { target: { value: text } }); act(() => vi.advanceTimersByTime(40)); }
  expect(fetch).toHaveBeenCalledTimes(1);
  await act(async () => { vi.advanceTimersByTime(300); await Promise.resolve(); });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(String(fetch.mock.calls[1][0])).toContain("search=playe"); expect(String(fetch.mock.calls[1][0])).not.toContain("before=");
  expect(navigation.url).toBe("/admin/users?debug=1&q=playe");
  expect(screen.getAllByText("player@example.test")).toHaveLength(2);
  expect(screen.getByRole("table").closest('[aria-busy="true"]')).toBeTruthy(); expect(screen.getByRole("status").textContent).toContain("Updating");
  await act(async () => { release(new Response(JSON.stringify({ items: [row], nextBefore: null }))); await pending; });
  fireEvent.keyDown(input, { key: "Escape" }); expect(document.activeElement).toBe(input); expect((input as HTMLInputElement).value).toBe("");
});

it("Back wins when the old debounce becomes due before navigation effects can run", async () => {
  navigation.visit("/admin/users?q=original");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ items: [row], nextBefore: null }))));
  render(<SWRConfig value={{ provider: () => new Map(), revalidateOnFocus: false }}><UsersPage /></SWRConfig>);
  await screen.findByRole("table"); vi.useFakeTimers();
  const input = screen.getByRole("textbox", { name: "Search" }); fireEvent.change(input, { target: { value: "stale-draft" } });
  act(() => vi.advanceTimersByTime(299));
  // Deliver Back and the due timeout in one batch, before React flushes navigation effects.
  await act(async () => { navigation.visit("/admin/users?q=restored&before=shared"); vi.advanceTimersByTime(1); await Promise.resolve(); });
  expect(router.replace).not.toHaveBeenCalled(); expect(navigation.url).toBe("/admin/users?q=restored&before=shared");
  expect((input as HTMLInputElement).value).toBe("restored");
});

it("preserves newer typing through a delayed own acknowledgement and resets it on external Back", async () => {
  navigation.visit("/admin/users"); navigation.defer = true;
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ items: [row], nextBefore: null }))));
  render(<SWRConfig value={{ provider: () => new Map(), revalidateOnFocus: false }}><UsersPage /></SWRConfig>);
  await screen.findByRole("table"); vi.useFakeTimers(); const input = screen.getByRole("textbox", { name: "Search" });
  fireEvent.change(input, { target: { value: "pla" } }); await act(async () => { vi.advanceTimersByTime(300); });
  expect(navigation.queued.map(next => next.url)).toEqual(["/admin/users?q=pla"]);
  fireEvent.change(input, { target: { value: "player" } });
  await act(async () => { navigation.acknowledge(); await Promise.resolve(); });
  expect((input as HTMLInputElement).value).toBe("player");
  await act(async () => { vi.advanceTimersByTime(300); });
  expect(navigation.queued.map(next => next.url)).toEqual(["/admin/users?q=player"]);
  await act(async () => { navigation.acknowledge(); await Promise.resolve(); });
  fireEvent.change(input, { target: { value: "unfinished" } });
  await act(async () => { navigation.visit("/admin/users?q=pla"); vi.advanceTimersByTime(500); await Promise.resolve(); });
  expect((input as HTMLInputElement).value).toBe("pla"); expect(navigation.queued).toHaveLength(0); expect(navigation.url).toBe("/admin/users?q=pla");
});
