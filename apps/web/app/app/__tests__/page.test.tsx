/**
 * /app (Today): the legacy ?opponent / ?tab redirects, then Settings →
 * "Default tab", which applies only to the first /app page of a browser
 * session (no sc2_app_session cookie yet). The cookie jar, the API and
 * redirect() are MOCKS; redirect throws like the real one.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  cookies: new Set<string>(),
  apiFetch: vi.fn(),
  redirect: vi.fn((href: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { href });
  }),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ has: (name: string) => harness.cookies.has(name) }),
}));
vi.mock("next/navigation", () => ({ redirect: harness.redirect }));
vi.mock("@/lib/api", () => ({ apiFetch: harness.apiFetch }));
vi.mock("@/components/dashboard/TodayView", () => ({
  TodayView: () => <div data-testid="today-view" />,
}));

import AppHome from "@/app/app/page";

type Query = Record<string, string | string[] | undefined>;

/** Resolves to the redirect target, or renders the page and returns null. */
async function visit(query: Query = {}): Promise<string | null> {
  try {
    const element = await AppHome({ searchParams: Promise.resolve(query) });
    render(element);
    return null;
  } catch (err) {
    const href = (err as { href?: string }).href;
    if (href === undefined) throw err;
    return href;
  }
}

function prefersTab(defaultTab: string) {
  harness.apiFetch.mockResolvedValue({ ok: true, status: 200, data: { defaultTab } });
}

beforeEach(() => {
  harness.cookies.clear();
  harness.apiFetch.mockReset();
  harness.redirect.mockClear();
});

afterEach(cleanup);

describe("/app default tab", () => {
  it.each(["today", ["today", "other"]])("keeps an explicit Today shortcut on Today (%j)", async (view) => {
    prefersTab("battlefield");
    expect(await visit({ view })).toBeNull();
    expect(screen.getByTestId("today-view")).toBeTruthy();
    expect(harness.apiFetch).not.toHaveBeenCalled();
    expect(harness.redirect).not.toHaveBeenCalled();
  });

  it("opens the saved section on the first /app page of a session", async () => {
    prefersTab("battlefield");
    expect(await visit()).toBe("/app/maps");
    expect(harness.redirect).toHaveBeenCalledWith("/app/maps");
    const [path, init] = harness.apiFetch.mock.calls[0];
    expect(path).toBe("/v1/me/preferences/misc");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("reads a section slug such as maps too", async () => {
    prefersTab("maps");
    expect(await visit()).toBe("/app/maps");
  });

  it("shows Today once the session cookie is set, without asking the API", async () => {
    harness.cookies.add("sc2_app_session");
    prefersTab("battlefield");
    expect(await visit()).toBeNull();
    expect(screen.getByTestId("today-view")).toBeTruthy();
    expect(harness.apiFetch).not.toHaveBeenCalled();
    expect(harness.redirect).not.toHaveBeenCalled();
  });

  it.each(["today", "", "ml"])("shows Today for the preference %j", async (pref) => {
    prefersTab(pref);
    expect(await visit()).toBeNull();
    expect(screen.getByTestId("today-view")).toBeTruthy();
  });

  it("shows Today when the preference request fails", async () => {
    harness.apiFetch.mockResolvedValue({ ok: false, status: 0, error: "The operation was aborted due to timeout" });
    expect(await visit()).toBeNull();
    expect(screen.getByTestId("today-view")).toBeTruthy();
  });

  it("shows Today when the preference lookup throws", async () => {
    harness.apiFetch.mockRejectedValue(new Error("boom"));
    expect(await visit()).toBeNull();
    expect(screen.getByTestId("today-view")).toBeTruthy();
  });

  it("shows Today when nothing is saved", async () => {
    harness.apiFetch.mockResolvedValue({ ok: true, status: 200, data: null });
    expect(await visit()).toBeNull();
    expect(screen.getByTestId("today-view")).toBeTruthy();
  });
});

describe("/app legacy links keep priority", () => {
  it("?tab= wins over the default tab", async () => {
    prefersTab("battlefield");
    expect(await visit({ tab: "trends" })).toBe("/app/trends");
    expect(harness.apiFetch).not.toHaveBeenCalled();
  });

  it("?opponent= opens the dossier", async () => {
    prefersTab("battlefield");
    expect(await visit({ opponent: "1-S2-1-42" })).toBe("/app/opponents/1-S2-1-42");
    expect(harness.apiFetch).not.toHaveBeenCalled();
  });
});
