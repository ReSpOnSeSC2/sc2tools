import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingDone } from "./OnboardingDone";
import type { PairedDevice } from "./pairingTypes";
import { getArticle } from "@/lib/help";

const h = vi.hoisted(() => ({ devices: [] as PairedDevice[], error: null as Error | null, mutate: vi.fn(), progress: { job: null as object | null, active: false, pct: 0, etaSeconds: null, refresh: vi.fn() } }));
vi.mock("@/lib/clientApi", () => ({ useApi: (path: string | null) => path?.includes("games") ? { data: { items: [{ gameId: "game/1" }] } } : { data: path ? { items: h.devices } : undefined, error: path ? h.error : null, mutate: h.mutate } }));
vi.mock("@/components/imports/useImportStatus", () => ({ useImportStatus: () => h.progress }));
vi.mock("@/components/imports/ImportProgressCard", () => ({ ImportProgressCard: ({ pct }: { pct: number }) => <p>Live import {pct}%</p> }));
vi.mock("@/components/help/LazyHelpLink", () => ({ LazyHelpLink: ({ slug, children }: { slug: string; children: React.ReactNode }) => <a href={`/help/${slug}`} data-help-slug={slug}>{children}</a> }));
beforeEach(() => { h.devices = []; h.error = null; h.mutate.mockReset(); h.progress = { job: null, active: false, pct: 0, etaSeconds: null, refresh: vi.fn() }; });
afterEach(cleanup);

describe("welcome completion", () => {
  it("offers real latest-game and identity actions to players with resolvable help", () => {
    const { container } = render(<OnboardingDone me={{ agentPaired: false, games: { total: 2 } }} goals={["improve"]} />);
    expect(screen.getByRole("link", { name: "Open your latest game" }).getAttribute("href")).toBe("/app/game/game%2F1");
    expect(screen.getByRole("link", { name: "Check your identity" })).toBeTruthy();
    for (const item of container.querySelectorAll("[data-help-slug]")) expect(getArticle(item.getAttribute("data-help-slug")!)).toBeTruthy();
  });
  it("keeps streaming actions focused and live import progress visible", () => {
    h.progress = { ...h.progress, job: { jobId: "job" }, active: true, pct: 42 };
    render(<OnboardingDone goals={["stream"]} />);
    expect(screen.getByRole("link", { name: "Open the crash course" }).getAttribute("href")).toBe("/stream-studio/learn#crash-course");
    expect(screen.getByRole("link", { name: "Copy your first overlay URL" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Check your identity" })).toBeNull();
    expect(screen.getByText("Live import 42%")).toBeTruthy();
  });
  it("calls a PC connected only after a recent heartbeat and offers Retry for a failed check", () => {
    const me = { agentPaired: true, games: { total: 0 } };
    h.devices = [{ deviceId: "pc", hostname: "GAMING-PC", createdAt: new Date().toISOString(), lastSeenAt: new Date(Date.now() - 86400000).toISOString(), agentVersion: "0.20.0" }];
    const view = render(<OnboardingDone me={me} goals={[]} />);
    expect(screen.getByRole("status").textContent).toContain("waiting for the app");
    h.devices[0].lastSeenAt = new Date().toISOString(); view.rerender(<OnboardingDone me={me} goals={[]} />);
    expect(screen.getByRole("status").textContent).toBe("Connected: GAMING-PC, v0.20.0");
    h.error = new Error("offline"); view.rerender(<OnboardingDone me={me} goals={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry desktop connection" })); expect(h.mutate).toHaveBeenCalledTimes(1);
  });
});
