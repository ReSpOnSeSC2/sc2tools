import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SetupHealthCard } from "../SetupHealthCard";
import { CopySetupDiagnostics, CopyUserId } from "../SetupDiagnostics";

const h = vi.hoisted(() => ({ sources: {} as Record<string, { data?: unknown; error?: Error; mutate: ReturnType<typeof vi.fn> }>, release: { data: { latest: "0.20.0" } as { latest: string } | undefined, error: undefined as Error | undefined, mutate: vi.fn() } }));
vi.mock("@/lib/clientApi", () => ({ useApi: (path: string | null) => path ? h.sources[path] : { mutate: vi.fn() } }));
vi.mock("@/components/onboarding/useReleaseInfo", () => ({ useReleaseInfo: () => h.release }));
vi.mock("@/components/help/LazyHelpLink", () => ({ LazyHelpLink: ({ children, slug, anchor }: { children: React.ReactNode; slug: string; anchor?: string }) => <a href={`/help/${slug}${anchor ? `#${anchor}` : ""}`}>{children}</a> }));
beforeEach(() => {
  h.sources = {
    "/v1/me": { data: { userId: "cloud-user", agentPaired: true, agentVersion: "0.20.0", agentLastSeenAt: new Date(Date.now() - 1000).toISOString(), games: { total: 12 }, onboarding: { goals: ["stream"] } }, mutate: vi.fn() },
    "/v1/me/doctor": { data: { ok: true, warnings: [] }, mutate: vi.fn() },
    "/v1/overlay-tokens": { data: { items: [{ token: "private-overlay", lastSeenAt: new Date().toISOString() }] }, mutate: vi.fn() },
  };
  h.release = { data: { latest: "0.20.0" }, error: undefined, mutate: vi.fn() };
});
afterEach(() => { cleanup(); Reflect.deleteProperty(navigator, "clipboard"); });

describe("setup health presentation and recovery", () => {
  it("shows a healthy overview and retries only a failed release source", () => {
    const view = render(<SetupHealthCard />);
    expect(screen.getByRole("heading", { name: "Everything's set up" })).toBeTruthy();
    h.release.error = new Error("offline"); view.rerender(<SetupHealthCard />);
    expect(screen.getByText("Couldn't check for updates")).toBeTruthy();
    expect(screen.getByText(/Online · seen/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry Up to date" }));
    expect(h.release.mutate).toHaveBeenCalledTimes(1);
    expect(h.sources["/v1/me"].mutate).not.toHaveBeenCalled();
  });
  it("names a Sync health warning and links its help section", () => {
    h.sources["/v1/me/doctor"] = { data: { ok: false, warnings: [{ id: "uploads_rejected", severity: "warn", message: "SC2 Tools recently rejected 2 uploads.", helpSlug: "my-game-didnt-show-up" }] }, mutate: vi.fn() };
    render(<SetupHealthCard />);
    expect(screen.getByRole("heading", { name: "1 thing needs attention" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Uploads rejected" })).toBeTruthy();
    expect(screen.getByText("SC2 Tools recently rejected 2 uploads.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "How to fix uploads rejected" }).getAttribute("href")).toBe("/help/my-game-didnt-show-up#sync-uploads-rejected");
  });
  it("copies the full user ID and selects it when clipboard access is blocked", async () => {
    const id = "cloud-" + "long-id-".repeat(12);
    const writeText = vi.fn().mockRejectedValue(new Error("blocked"));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<CopyUserId value={id} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Copy user ID" })); });
    expect(writeText).toHaveBeenCalledWith(id); expect(window.getSelection()?.toString()).toBe(id);
    expect(screen.getByText(/Selected\. Copy/)).toBeTruthy();
  });
  it("offers selected diagnostic text as a clipboard fallback", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error("blocked")) } });
    render(<CopySetupDiagnostics me={{ userId: "cloud-user", games: { total: 5 } }} warnings={["no_profile"]} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Copy diagnostics" })); });
    const field = screen.getByRole("textbox", { name: "Diagnostics to copy" }) as HTMLTextAreaElement;
    expect(field.value).toContain("cloud-user"); expect(field.selectionEnd).toBe(field.value.length);
    expect(document.activeElement).toBe(field);
  });
});
