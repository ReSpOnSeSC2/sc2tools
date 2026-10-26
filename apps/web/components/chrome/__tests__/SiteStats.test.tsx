import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SiteStats } from "../SiteStats";

const response = vi.hoisted(() => ({
  data: undefined as undefined | {
    agentDownloads: number | null;
    activeAgents: number | null;
    activeUsers: number | null;
    generatedAt: string;
    activityWindowSeconds: number;
    receivedAt: number;
  },
  error: undefined as Error | undefined,
  isLoading: false,
}));
vi.mock("swr", () => ({ default: () => response }));

afterEach(() => {
  cleanup();
  response.data = undefined;
  response.error = undefined;
  response.isLoading = false;
  vi.useRealTimers(); vi.restoreAllMocks(); localStorage.clear();
});

function snapshot() {
  response.data = {
    agentDownloads: 12345,
    activeAgents: 12,
    activeUsers: 0,
    generatedAt: new Date().toISOString(),
    activityWindowSeconds: 180,
    receivedAt: Date.now(),
  };
}

describe("public community activity", () => {
  it("shows exact counts including a real zero and accessible definitions", () => {
    snapshot();
    render(<SiteStats />);
    expect(screen.getByText("12,345")).toBeTruthy();
    expect(screen.getByText("12")).toBeTruthy();
    expect(screen.getByText("0")).toBeTruthy();
    const toggle = screen.getByRole("button", { name: "About these activity counts" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(/completed installations are not measured/)).toBeTruthy();
    expect(screen.getByText(/Signed-in users count once across devices/)).toBeTruthy();
  });

  it("uses decorative loading placeholders with readable text and one aggregate status", () => {
    response.isLoading = true;
    const { rerender } = render(<SiteStats />);
    const counts = screen.getByRole("group", { name: "Game sync and site activity" }).querySelectorAll("dd");
    expect(counts).toHaveLength(3);
    for (const count of counts) {
      expect(count.textContent).toBe("Loading");
      expect(count.querySelector("[aria-label]")).toBeNull();
      expect(count.querySelector("[aria-hidden='true']")?.className).toContain("motion-safe:animate-pulse");
    }
    expect(screen.queryByText("0")).toBeNull();
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status").textContent).toBe("Loading activity");
    // A background refresh with a fresh snapshot must not announce loading
    // again or replace known values with placeholders.
    snapshot(); rerender(<SiteStats />);
    expect(screen.queryAllByText("Loading")).toHaveLength(0);
    expect(screen.getByText("12,345")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Updates every 30 seconds");
  });

  it("keeps independently available metrics when one source fails", () => {
    snapshot();
    response.data!.activeUsers = null;
    render(<SiteStats />);
    expect(screen.getByText("12,345")).toBeTruthy();
    expect(screen.getByText("12")).toBeTruthy();
    expect(screen.getAllByText("Unavailable")).toHaveLength(1);
    expect(screen.getByRole("status").textContent).toBe("Some counts unavailable");
  });

  it("does not present the last successful counts as current during an outage", () => {
    snapshot();
    response.error = new Error("Network unavailable");
    render(<SiteStats />);
    expect(screen.queryByText("12,345")).toBeNull();
    expect(screen.getAllByText("Unavailable")).toHaveLength(3);
    for (const text of screen.getAllByText("Unavailable")) {
      expect(text.hasAttribute("aria-label")).toBe(false);
      expect(text.previousElementSibling?.getAttribute("aria-hidden")).toBe("true");
    }
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status").textContent).toBe("Updates unavailable");
  });

  it("expires stale cached data even without a new network response", () => {
    vi.useFakeTimers();
    snapshot();
    response.data!.generatedAt = new Date(Date.now() - 100_000).toISOString();
    response.data!.receivedAt = Date.now() - 100_000;
    render(<SiteStats />);
    expect(screen.getAllByText("Unavailable")).toHaveLength(3);
    expect(screen.queryByText("12,345")).toBeNull();
  });

  it("does not mistake a different server clock for stale data", () => {
    snapshot();
    response.data!.generatedAt = new Date(Date.now() - 3_600_000).toISOString();
    render(<SiteStats />);
    expect(screen.getByText("12,345")).toBeTruthy();
    expect(screen.queryByText("Unavailable")).toBeNull();
  });
});


describe("compact app activity", () => {
  it("keeps community counts in a persisted disclosure and includes the supplied agent pill", () => {
    snapshot(); const first = render(<SiteStats variant="app" signedIn analyzer syncStatus={<span>Agent online</span>} />);
    const toggle = screen.getByRole("button", { name: /Community · 0 online/ }); const details = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    expect(details.hidden).toBe(true); expect(screen.getByText("Agent online")).toBeTruthy(); fireEvent.click(toggle); expect(details.hidden).toBe(false); expect(localStorage.getItem("sc2tools:activity-details:v1")).toBe("expanded");
    first.unmount(); render(<SiteStats variant="app" signedIn analyzer />); expect(screen.getByRole("button", { name: /Community/ }).getAttribute("aria-expanded")).toBe("true");
  });
  it("keeps storage failures non-fatal and does not invent an online count on error", () => {
    snapshot(); response.error = new Error("offline"); vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); }); vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    render(<SiteStats variant="app" signedIn />); const toggle = screen.getByRole("button", { name: /Community · unavailable/ }); fireEvent.click(toggle); expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });
});
