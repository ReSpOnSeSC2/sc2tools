import { Suspense } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import UsersPage from "../users/page";
import UserDetail from "../users/[userId]/page";
import { AdminUsersExport } from "./AdminUsersExport";
import { AdminIdCopy } from "./AdminIdCopy";
import { navigation } from "./__tests__/navigationFixture";
const mocks = vi.hoisted(() => ({ useApi: vi.fn(), save: vi.fn(), toast: vi.fn(), auth: { userId: "admin", isLoaded: true, isSignedIn: true, getToken: vi.fn(async (): Promise<string | null> => "test-token") } }));
vi.mock("next/navigation", () => import("./__tests__/navigationFixture"));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => mocks.auth }));
vi.mock("@/lib/clientApi", async original => ({ ...await original<object>(), useApi: (...args: unknown[]) => mocks.useApi(...args) }));
vi.mock("@/lib/replayCsvDownload", () => ({ saveReplayCsv: (...args: unknown[]) => mocks.save(...args) }));
vi.mock("@/components/ui/Toast", () => ({ useToastOptional: () => ({ toast: { success: mocks.toast } }) }));
vi.mock("./AdminActionCard", () => ({ AdminActionCard: () => null }));
vi.mock("./AdminRoleCard", () => ({ AdminRoleCard: () => null }));

const date = "2026-10-20T12:00:00.000Z";
const row = { userId: "user/a", clerkUserId: "clerk/a", email: "fixture@example.test", isAdmin: true, hasAgent: true, agentLastSeenAt: date, createdAt: date, lastActivity: date, firstActivity: date, gameCount: 5, opponentCount: 1 };
const detail = { ...row, lastSeenAt: date, games: { total: 5, wins: 2, losses: 1, firstActivity: date, lastActivity: date }, opponents: { total: 1, top: [{ pulseId: "p/a", displayNameSample: "Rival", race: "Protoss", gameCount: 5, wins: 2, losses: 1 }] }, recentGames: [{ gameId: "g|1", date, map: "Synthetic map", result: "Victory", opponent: { name: "Rival", pulseId: "p/a" } }] };
beforeEach(() => {
  navigation.visit("/admin/users"); vi.clearAllMocks(); mocks.auth.isLoaded = true; mocks.auth.isSignedIn = true; mocks.auth.userId = "admin"; mocks.auth.getToken.mockResolvedValue("test-token");
  mocks.useApi.mockImplementation((path: string) => ({ data: path.includes("/support") ? { devices: [{ deviceId: "d", os: "Windows", version: "0.test", online: true, lastSeenAt: date }], doctor: { warnings: [] }, replayArchive: { totalGames: 5, archivedGames: 5, missingGames: 0 }, imports: [], audit: [] } : path.startsWith("/v1/admin/events?") ? { items: [], nextBefore: null } : path.startsWith("/v1/admin/users?") ? { items: [row], total: 101, page: 1, limit: 50, hasMore: true } : detail, mutate: vi.fn(), isLoading: false, isValidating: false }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("shows signup/Admin badge, real total, sortable URL pages, and absolute time titles", () => {
  render(<UsersPage />);
  expect(screen.getByRole("table").textContent).toContain("Signed up");
  expect(within(screen.getByRole("table")).getByText("Admin")).toBeTruthy();
  expect(screen.getByText("1–1 of 101 users")).toBeTruthy();
  expect(document.querySelector("time")?.getAttribute("dateTime")).toBe(date);
  expect(document.querySelector("time")?.title).toContain("2026");
  fireEvent.click(screen.getByRole("button", { name: /^Games/ }));
  expect(navigation.url).toContain("sort=games");
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(navigation.url).toContain("page=2");
  fireEvent.click(screen.getByRole("button", { name: "Admins" }));
  expect(navigation.url).toContain("filter=admins"); expect(navigation.url).not.toContain("page=");
});
it("renders decided win rate, linked opponent/game, support platform, and user-scoped activity", async () => {
  await act(async () => { render(<Suspense><UserDetail params={Promise.resolve({ userId: "user/a" })} /></Suspense>); });
  expect(await screen.findByText("67%")).toBeTruthy();
  expect(screen.getByText("Signed up")).toBeTruthy(); expect(screen.queryByText("Account age")).toBeNull();
  expect(screen.getByText(/Windows.*Online.*Last seen/)).toBeTruthy();
  expect(screen.getAllByRole("link", { name: /Rival/ })[0].getAttribute("href")).toBe("/admin/users/user%2Fa/opponents/p%2Fa");
  expect(screen.getAllByRole("link", { name: "Synthetic map" })[0].getAttribute("href")).toBe("/admin/users/user%2Fa/opponents/p%2Fa?game=g%7C1");
  expect(screen.getAllByText("Win")).toHaveLength(2);
  expect(mocks.useApi.mock.calls.some(([path]) => path === "/v1/admin/events?userId=user%2Fa&limit=10")).toBe(true);
  expect(screen.getByRole("link", { name: /View all activity/ }).getAttribute("href")).toContain("userId=user%2Fa&unread=0");
});
it("shows missing dates and no decided games without invented zeros", async () => {
  mocks.useApi.mockImplementation((path: string) => ({ data: path.startsWith("/v1/admin/users/") && !path.endsWith("/support") ? { ...detail, createdAt: null, lastSeenAt: null, games: { total: 1, wins: 0, losses: 0, firstActivity: null, lastActivity: null }, opponents: { total: 0, top: [] }, recentGames: [] } : undefined }));
  await act(async () => { render(<Suspense><UserDetail params={Promise.resolve({ userId: "empty" })} /></Suspense>); });
  expect(await screen.findByText("No decided games")).toBeTruthy(); expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(5);
});
it("copies IDs with toast and falls back to a selected readonly input", async () => {
  const writeText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("denied"));
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  render(<AdminIdCopy label="userId" value="user/a" />);
  fireEvent.click(screen.getByRole("button", { name: "Copy userId" })); await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith("Copied"));
  fireEvent.click(screen.getByRole("button", { name: "Copy userId" }));
  const input = await screen.findByRole("textbox", { name: "userId to copy" }) as HTMLInputElement;
  expect(input.readOnly).toBe(true); expect(input.selectionEnd).toBe("user/a".length); expect(document.activeElement).toBe(input);
});
it("does not expose a stale clipboard result after a different user loads", async () => {
  let reject!: (error: Error) => void;
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: () => new Promise((_resolve, failed) => { reject = failed; }) } });
  const view = render(<AdminIdCopy label="userId" value="old" />); fireEvent.click(screen.getByRole("button", { name: "Copy userId" }));
  view.rerender(<AdminIdCopy label="userId" value="new" />); await act(async () => { reject(new Error("late")); });
  expect(screen.queryByRole("textbox")).toBeNull(); expect(mocks.toast).not.toHaveBeenCalled();
});
it("downloads the server blob with auth/filter scope and reports the cap", async () => {
  const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response("safe,csv", { headers: { "X-Export-Truncated": "true" } })); vi.stubGlobal("fetch", fetch);
  render(<AdminUsersExport query="filter=admins&q=fixture" />); fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
  expect(await screen.findByText(/Limited to the first 10,000/)).toBeTruthy();
  expect(fetch.mock.calls[0][0]).toContain("/v1/admin/users/export.csv?filter=admins&q=fixture");
  expect(fetch.mock.calls[0][1]).toMatchObject({ headers: { authorization: "Bearer test-token" }, cache: "no-store" });
  expect(mocks.save.mock.calls[0][0].size).toBe(8); expect(mocks.save.mock.calls[0][1]).toMatch(/^sc2tools-users-.*\.csv$/);
});
it("settles held auth at the export deadline and never sends it after scope/signout changes", async () => {
  vi.useFakeTimers(); const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  let resolve!: (value: string) => void; mocks.auth.getToken.mockReturnValue(new Promise(done => { resolve = done; }));
  const view = render(<AdminUsersExport query="filter=all" />); fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
  await act(async () => { vi.advanceTimersByTime(60000); });
  expect(screen.getByRole("status").textContent).toContain("too long");
  expect((screen.getByRole("button", { name: "Export CSV" }) as HTMLButtonElement).disabled).toBe(false);
  mocks.auth.isLoaded = false; view.rerender(<AdminUsersExport query="filter=all" />);
  await act(async () => { resolve("stale"); }); expect(fetch).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
});
