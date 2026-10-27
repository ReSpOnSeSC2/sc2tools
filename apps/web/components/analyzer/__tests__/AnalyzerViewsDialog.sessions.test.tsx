import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AnalyzerViewPrefs } from "@/lib/analyzerViews";

const h = vi.hoisted(() => ({
  pathname: "/app/sessions", filters: {} as Record<string, unknown>,
  prefs: { views: [], defaultViewId: null } as AnalyzerViewPrefs,
  apiCall: vi.fn<(_token: unknown, path: string, init: { method?: string; body: string }) => Promise<AnalyzerViewPrefs>>(),
  getToken: vi.fn(), replace: vi.fn(), mutate: vi.fn(),
}));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ userId: "owner-a", getToken: h.getToken }) }));
vi.mock("next/navigation", () => ({ usePathname: () => h.pathname, useRouter: () => ({ replace: h.replace }) }));
vi.mock("@/lib/filterContext", () => ({ useFilters: () => ({ filters: h.filters }) }));
vi.mock("@/components/help/LazyHelpLink", () => ({ LazyHelpLink: ({ children }: { children: ReactNode }) => <span>{children}</span> }));
vi.mock("@/lib/clientApi", async () => {
  const { useState } = await import("react");
  return { apiCall: h.apiCall, useApi: () => {
    const [data, setData] = useState(h.prefs);
    return { data, isLoading: false, error: undefined, mutate: async (next: AnalyzerViewPrefs) => { h.mutate(next); h.prefs = next; setData(next); } };
  } };
});
import { AnalyzerViewsDialog } from "../AnalyzerViewsDialog";

beforeEach(() => {
  h.pathname = "/app/sessions"; h.prefs = { views: [], defaultViewId: null };
  h.filters = { preset: "current_season", race: "P", accounts: "1-S2-1-12345", map_pool: "all", game_size: "all", exclude_too_short: false, day: "2026-10-27", before: "private-list-cursor", gamesBefore: "private-game-cursor", sessionView: "current", token: "secret" };
  h.apiCall.mockReset().mockImplementation(async (_token, _path, init) => JSON.parse(init.body) as AnalyzerViewPrefs);
  h.getToken.mockReset().mockResolvedValue("synthetic-token"); h.replace.mockReset(); h.mutate.mockReset();
});
afterEach(() => { cleanup(); window.history.replaceState({}, "", "/"); });

it.each(["/app/sessions", "/app/sessions/private-report"])("saves, reads and applies a list cohort from %s without report transport", async pathname => {
  h.pathname = pathname; window.history.replaceState({}, "", `${pathname}?day=2026-10-27&before=private-list-cursor&gamesBefore=private-game-cursor`);
  const close = vi.fn(); render(<AnalyzerViewsDialog onClose={close} />);
  fireEvent.change(screen.getByLabelText("View name"), { target: { value: "My sessions" } });
  fireEvent.click(screen.getByRole("button", { name: "Save current view" }));
  const apply = await screen.findByRole("button", { name: "Apply My sessions" });
  const write = h.apiCall.mock.calls[0];
  if (!write) throw new Error("Saving the Sessions view did not issue a preference write");
  expect(write[1]).toBe("/v1/me/preferences/analyzerViews"); expect(write[2].method).toBe("PUT");
  const saved = JSON.parse(write[2].body) as AnalyzerViewPrefs;
  expect(saved.views).toHaveLength(1);
  expect(saved.views[0]).toMatchObject({ name: "My sessions", section: "sessions", filters: { preset: "current_season", race: "P", accounts: "1-S2-1-12345", map_pool: "all", game_size: "all", exclude_too_short: false } });
  expect(saved.views[0].filters).not.toHaveProperty("day"); expect(saved.views[0].filters).not.toHaveProperty("before");
  expect(saved.views[0].filters).not.toHaveProperty("gamesBefore"); expect(saved.views[0].filters).not.toHaveProperty("sessionView"); expect(saved.views[0].filters).not.toHaveProperty("token");
  expect(JSON.stringify(saved)).not.toMatch(/private-report|private-list-cursor|private-game-cursor|secret/);
  expect(h.mutate).toHaveBeenCalledWith(saved);
  fireEvent.click(apply);
  const navigation = h.replace.mock.calls[0];
  if (!navigation) throw new Error("Applying the Sessions view did not navigate");
  const url = new URL(navigation[0] as string, "https://sc2tools.invalid");
  expect(url.pathname).toBe("/app/sessions");
  expect(Object.fromEntries(url.searchParams)).toEqual({ filters: "1", preset: "current_season", race: "P", accounts: "1-S2-1-12345", map_pool: "all", game_size: "all", exclude_too_short: "false" });
  expect(navigation[1]).toEqual({ scroll: false }); expect(close).toHaveBeenCalledOnce(); expect(h.apiCall).toHaveBeenCalledOnce();
});
