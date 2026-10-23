import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SWRConfig } from "swr";
import type { ReactNode } from "react";
import type { SiteNotice } from "@/components/ui/Banner";
const harness = vi.hoisted(() => ({ userId: "ann" as string | null, handlers: null as Record<string, (value: unknown) => void> | null }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: !!harness.userId, userId: harness.userId, getToken: async () => "fixture-token" }) }));
vi.mock("next/navigation", () => ({ usePathname: () => "/app" }));
vi.mock("@/lib/useUserSocket", () => ({ useUserSocket: (handlers: typeof harness.handlers) => { harness.handlers = handlers; } }));
vi.mock("@/components/help/LazyHelpLink", () => ({ LazyHelpLink: ({ slug, children }: { slug: string; children?: ReactNode }) => <a href={`/help/${slug}`}>{children || "Help"}</a> }));
import { WhatsNewButton } from "../WhatsNewButton";
import { SiteIncidentBanner } from "../SiteIncidentBanner";
import { Changelog } from "../Changelog";
import AnnouncementsPage from "@/app/admin/announcements/page";

let banner: SiteNotice | null; let failSave: boolean; let failEnd: boolean; let failSeen: boolean;
let onboarding: { goals: string[]; whatsNewSeenAt?: string; dismissedAt: string };
let fetcher: ReturnType<typeof vi.fn>;
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const makeNotice = (patch: Partial<SiteNotice> = {}): SiteNotice => ({ severity: "warning", message: "Uploads are delayed.", audience: "all", href: "/help/desktop-app-overview", startsAt: new Date(Date.now() - 60000).toISOString(), endsAt: new Date(Date.now() + 3600000).toISOString(), revision: 1, hash: "fixture-warning", ...patch });
const mount = (children: ReactNode) => render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>{children}</SWRConfig>);
beforeEach(() => {
  harness.userId = "ann"; harness.handlers = null; localStorage.clear(); banner = null; failSave = false; failEnd = false; failSeen = false; onboarding = { goals: ["improve"], dismissedAt: "keep-this-field" };
  fetcher = vi.fn(async (raw: string, init?: RequestInit) => {
    const url = new URL(raw, "http://localhost");
    if (url.pathname === "/v1/me") return response({ onboarding });
    if (url.pathname.endsWith("/preferences/onboarding")) { if (failSeen) return response({ error: { code: "internal_error" } }, 503); onboarding = { ...onboarding, ...JSON.parse(init!.body as string) }; return response(onboarding); }
    if (url.pathname.endsWith("/site/banner")) return response({ banner });
    if (url.pathname.endsWith("/admin/announcements")) {
      if (init?.method === "PUT") { if (failSave) return response({ error: { code: "internal_error" } }, 503); const value = JSON.parse(init.body as string); banner = makeNotice({ ...value, revision: (banner?.revision || 0) + 1, hash: "saved-notice" }); }
      if (init?.method === "DELETE") { if (failEnd) return response({ error: { code: "internal_error" } }, 503); banner = makeNotice({ ...banner!, endsAt: new Date().toISOString(), revision: banner!.revision + 1 }); }
      return response({ banner });
    }
    return response({});
  }); vi.stubGlobal("fetch", fetcher);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("announcement consumers with real client requests", () => {
  it("opens the goal-filtered sheet, retries saving only its seen field, and returns focus on close", async () => {
    failSeen = true; mount(<WhatsNewButton />);
    const button = await screen.findByRole("button", { name: "What's new, unread updates" }); button.focus(); fireEvent.click(button);
    await screen.findByRole("dialog", { name: "What's new" }); expect(await screen.findByText("Your activity and report replies in one inbox")).toBeTruthy();
    expect(screen.queryByText("Stream controls recover without losing your draft")).toBeNull(); await screen.findByRole("alert");
    failSeen = false; fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByRole("button", { name: "What's new" });
    const writes = fetcher.mock.calls.filter(([, init]) => init?.method === "PUT").map(([, init]) => JSON.parse(init!.body as string));
    expect(writes).toHaveLength(2); expect(Object.keys(writes[1])).toEqual(["whatsNewSeenAt"]); expect(onboarding.goals).toEqual(["improve"]); expect(onboarding.dismissedAt).toBe("keep-this-field");
    fireEvent.keyDown(document, { key: "Escape" }); await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull()); expect(document.activeElement).toBe(button);
  });

  it("keeps What's New signed-in only and lets public readers filter the full changelog", () => {
    harness.userId = null; mount(<><WhatsNewButton /><Changelog /></>); expect(screen.queryByRole("button", { name: /What's new/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Guides" })); expect(screen.getByText("No Guides updates yet.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Agent" })); expect(screen.getByRole("button", { name: "Agent" }).getAttribute("aria-pressed")).toBe("true"); expect(screen.getByText("Check your PC before linking it")).toBeTruthy();
  });

  it("dismisses only the current non-critical notice, refreshes on socket changes, and expires critical notices", async () => {
    banner = makeNotice(); mount(<SiteIncidentBanner />); await screen.findByText("Uploads are delayed."); fireEvent.click(screen.getByRole("button", { name: "Dismiss notice" })); expect(screen.queryByRole("status")).toBeNull();
    banner = makeNotice({ severity: "critical", hash: "new-critical", message: "Maintenance in progress.", endsAt: new Date(Date.now() + 300).toISOString() });
    act(() => harness.handlers?.["site:banner"]({ hash: "new-critical" })); await screen.findByText("Maintenance in progress."); expect(screen.queryByRole("button", { name: "Dismiss notice" })).toBeNull();
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(fetcher.mock.calls.some(([url]) => String(url).includes("?v=new-critical"))).toBe(true);
  });

  it("preserves an admin draft on failure and retries a failed end action as DELETE after closing confirmation", async () => {
    mount(<AnnouncementsPage />); await screen.findByRole("button", { name: "Maintenance" }); fireEvent.click(screen.getByRole("button", { name: "Maintenance" }));
    fireEvent.change(screen.getByRole("textbox", { name: /Message/ }), { target: { value: "Fixture maintenance notice." } }); failSave = true; fireEvent.click(screen.getByRole("button", { name: "Save notice" }));
    await screen.findByRole("alert"); expect((screen.getByRole("textbox", { name: /Message/ }) as HTMLTextAreaElement).value).toBe("Fixture maintenance notice.");
    failSave = false; fireEvent.click(screen.getByRole("button", { name: "Retry" })); await screen.findByText("Notice saved");
    fireEvent.click(screen.getByRole("button", { name: "End current notice" })); failEnd = true; fireEvent.click(screen.getByRole("button", { name: "End notice" }));
    await screen.findByRole("alert"); fireEvent.keyDown(document, { key: "Escape" }); failEnd = false; fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(fetcher.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(2));
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(2);
  });
});
