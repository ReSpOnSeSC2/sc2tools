import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  cookies: new Set<string>(), apiFetch: vi.fn(),
  redirect: vi.fn((href: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { href }); }),
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ has: (name: string) => h.cookies.has(name) }) }));
vi.mock("next/navigation", () => ({ redirect: h.redirect }));
vi.mock("@/lib/api", () => ({ apiFetch: h.apiFetch }));
vi.mock("@/components/dashboard/TodayView", () => ({ TodayView: () => <div data-testid="sessions-default-today" /> }));
import AppHome from "@/app/app/page";

async function visit(query: Record<string, string> = {}): Promise<string | null> {
  try { render(await AppHome({ searchParams: Promise.resolve(query) })); return null; }
  catch (error) { const href = (error as { href?: string }).href; if (href === undefined) throw error; return href; }
}
beforeEach(() => {
  h.cookies.clear(); h.apiFetch.mockReset(); h.redirect.mockClear();
  h.apiFetch.mockResolvedValue({ ok: true, data: { defaultTab: "maps", defaultView: {
    id: "sessions-one", name: "Current season sessions", section: "sessions",
    filters: { preset: "current_season", race: "P", accounts: "1-S2-1-12345", map_pool: "all", game_size: "all", exclude_too_short: false, day: "2026-10-27", gamesBefore: "private-game-cursor" },
  } } });
});
afterEach(cleanup);

it("opens the selected Sessions list cohort ahead of the legacy default tab on the first plain Today visit", async () => {
  const href = await visit();
  if (!href) throw new Error("The saved Sessions default did not redirect");
  const url = new URL(href, "https://sc2tools.invalid");
  expect(url.pathname).toBe("/app/sessions");
  expect(Object.fromEntries(url.searchParams)).toEqual({ filters: "1", preset: "current_season", race: "P", accounts: "1-S2-1-12345", map_pool: "all", game_size: "all", exclude_too_short: "false" });
  expect(h.redirect).toHaveBeenCalledWith(href); expect(h.apiFetch).toHaveBeenCalledOnce();
  expect(h.apiFetch.mock.calls[0][0]).toBe("/v1/me/analyzer-default-view");
  expect(h.apiFetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
});

it("keeps the explicit Today shortcut ahead of a saved Sessions default", async () => {
  expect(await visit({ view: "today" })).toBeNull(); expect(screen.getByTestId("sessions-default-today")).toBeTruthy();
  expect(h.apiFetch).not.toHaveBeenCalled(); expect(h.redirect).not.toHaveBeenCalled();
});

it("does not reopen the saved Sessions default later in the same browser session", async () => {
  h.cookies.add("sc2_app_session");
  expect(await visit()).toBeNull(); expect(screen.getByTestId("sessions-default-today")).toBeTruthy();
  expect(h.apiFetch).not.toHaveBeenCalled(); expect(h.redirect).not.toHaveBeenCalled();
});
