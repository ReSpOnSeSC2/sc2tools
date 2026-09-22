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
  vi.useRealTimers();
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

  it("shows loading placeholders without inventing counts", () => {
    response.isLoading = true;
    render(<SiteStats />);
    expect(screen.getAllByLabelText("Loading")).toHaveLength(3);
    expect(screen.queryByText("0")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Loading activity");
  });

  it("keeps independently available metrics when one source fails", () => {
    snapshot();
    response.data!.activeUsers = null;
    render(<SiteStats />);
    expect(screen.getByText("12,345")).toBeTruthy();
    expect(screen.getByText("12")).toBeTruthy();
    expect(screen.getAllByLabelText("Unavailable")).toHaveLength(1);
    expect(screen.getByRole("status").textContent).toBe("Some counts unavailable");
  });

  it("does not present the last successful counts as current during an outage", () => {
    snapshot();
    response.error = new Error("Network unavailable");
    render(<SiteStats />);
    expect(screen.queryByText("12,345")).toBeNull();
    expect(screen.getAllByLabelText("Unavailable")).toHaveLength(3);
    expect(screen.getByRole("status").textContent).toBe("Updates unavailable");
  });

  it("expires stale cached data even without a new network response", () => {
    vi.useFakeTimers();
    snapshot();
    response.data!.generatedAt = new Date(Date.now() - 100_000).toISOString();
    response.data!.receivedAt = Date.now() - 100_000;
    render(<SiteStats />);
    expect(screen.getAllByLabelText("Unavailable")).toHaveLength(3);
    expect(screen.queryByText("12,345")).toBeNull();
  });

  it("does not mistake a different server clock for stale data", () => {
    snapshot();
    response.data!.generatedAt = new Date(Date.now() - 3_600_000).toISOString();
    render(<SiteStats />);
    expect(screen.getByText("12,345")).toBeTruthy();
    expect(screen.queryByLabelText("Unavailable")).toBeNull();
  });
});
