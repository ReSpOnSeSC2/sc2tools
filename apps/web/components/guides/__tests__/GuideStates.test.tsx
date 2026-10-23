import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ refresh: vi.fn(), pending: false }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: h.refresh }), usePathname: () => "/guides" }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: false }) }));
vi.mock("next/link", async (original) => ({ ...await original<typeof import("next/link")>(), useLinkStatus: () => ({ pending: h.pending }) }));
import { GuideUnavailable } from "../GuideStates";
import GuidesError from "@/app/guides/error";
import { GuideFilterPendingProvider, GuideFilterRegion } from "../matchup/GuideFilterPending";
import { FilterPillLabel } from "../matchup/FilterPillLabel";

afterEach(() => { cleanup(); vi.clearAllMocks(); h.pending = false; });
describe("guide recovery and pending feedback", () => {
  it("refreshes the hub and offers dashboard/home rather than a self-link", () => {
    render(<GuideUnavailable variant="hub" />);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(h.refresh).toHaveBeenCalledOnce();
    expect(screen.getByRole("link", { name: "Open your dashboard" }).getAttribute("href")).toBe("/app");
    expect(screen.getByRole("link", { name: "Home" }).getAttribute("href")).toBe("/");
    expect(screen.queryByRole("link", { name: "All build guides" })).toBeNull();
  });
  it("refreshes and resets the guide error boundary while keeping noindex", () => {
    const reset = vi.fn();
    render(<GuidesError error={new Error("outage")} reset={reset} />);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(reset).toHaveBeenCalledOnce(); expect(h.refresh).toHaveBeenCalledOnce();
    expect(document.querySelector('meta[name="robots"]')?.getAttribute("content")).toBe("noindex, nofollow");
  });
  it("marks the table busy and announces the requested band while its link is pending", () => {
    h.pending = true;
    render(<GuideFilterPendingProvider><FilterPillLabel label="Diamond" /><GuideFilterRegion><table aria-label="Openers" /></GuideFilterRegion></GuideFilterPendingProvider>);
    expect(screen.getByRole("table").parentElement?.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByRole("status").textContent).toBe("Loading Diamond openers…");
    expect(screen.getByText("Diamond").getAttribute("data-pending")).toBe("true");
  });
});
