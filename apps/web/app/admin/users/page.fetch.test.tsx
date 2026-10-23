import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SWRConfig } from "swr";
import UsersPage from "./page";
import { navigation } from "../components/__tests__/navigationFixture";
vi.mock("next/navigation", () => import("../components/__tests__/navigationFixture"));
const auth = vi.hoisted(() => ({ getToken: vi.fn(async () => "fixture-token"), isLoaded: true, isSignedIn: true, userId: "admin-fixture" }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => auth }));
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const row = { userId: "player", clerkUserId: "clerk-player", email: "player@example.test", gameCount: 12, opponentCount: 4, hasAgent: false, agentLastSeenAt: null, lastActivity: null, firstActivity: null, storageEstimateBytes: 0 };

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
