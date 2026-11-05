import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SWRConfig } from "swr";
import { SiteStats } from "../SiteStats";

describe("visible community statistics polling", () => {
  const fetchMock = vi.fn();
  const mediaListeners = new Set<() => void>();
  let wide: boolean;
  let visibility: DocumentVisibilityState;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-04T12:00:00.000Z"));
    vi.stubEnv("NEXT_PUBLIC_API_BASE", "https://api.sc2tools.test/");
    wide = false;
    visibility = "visible";
    mediaListeners.clear();
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      get matches() { return wide; },
      addEventListener: (_type: string, listener: () => void) => mediaListeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => mediaListeners.delete(listener),
    })));
    fetchMock.mockReset().mockImplementation(async () => Response.json({
      agentDownloads: 42, activeAgents: 3, activeUsers: 7,
      generatedAt: new Date().toISOString(), activityWindowSeconds: 180,
    }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    cleanup();
    fireEvent(window, new Event("online"));
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    localStorage.clear();
  });

  async function mount(variant: "app" | "marketing") {
    let view: ReturnType<typeof render>;
    await act(async () => {
      view = render(<SWRConfig value={{ provider: () => new Map(), errorRetryCount: 0 }}>
        <SiteStats variant={variant} signedIn syncStatus={<span>Agent online</span>} />
      </SWRConfig>);
    });
    return view!;
  }

  async function resize(desktop: boolean) {
    await act(async () => {
      wide = desktop;
      fireEvent(window, new Event("resize"));
      for (const listener of mediaListeners) listener();
    });
  }

  async function elapse(ms: number) {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  }

  it("starts app polling at xl and stops it when counts become hidden on resize", async () => {
    const view = await mount("app");
    expect(screen.getByText("Agent online")).toBeTruthy();
    await elapse(60_000);
    expect(fetchMock).not.toHaveBeenCalled();

    await resize(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Community · 7 online" })).toBeTruthy();
    await elapse(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await resize(false);
    await elapse(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await resize(true);
    // SWR schedules revalidation of a retained snapshot on the next frame.
    await elapse(20);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(window.matchMedia).toHaveBeenCalledWith("(min-width:1280px)");
    view.unmount();
    expect(mediaListeners.size).toBe(0);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe("https://api.sc2tools.test/v1/site/stats");
      expect(init.credentials).toBe("omit");
      expect(init.headers).toBeUndefined();
    }
  });

  it("keeps marketing counts fresh every 30 seconds on a narrow viewport without a website request", async () => {
    await mount("marketing");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await elapse(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://api.sc2tools.test/v1/site/stats", "https://api.sc2tools.test/v1/site/stats",
    ]);
    expect(screen.getByRole("status").textContent).toBe("Updates every 30 seconds");
  });

  it("continues to suppress polling when the document is hidden or the browser is offline", async () => {
    await mount("marketing");
    visibility = "hidden";
    await elapse(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    visibility = "visible";
    await elapse(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fireEvent(window, new Event("offline"));
    await elapse(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("shows unavailable counts when the direct API returns malformed data", async () => {
    fetchMock.mockResolvedValue(Response.json({ activeUsers: "private invalid payload" }));
    await mount("marketing");
    expect(screen.getByRole("status").textContent).toBe("Updates unavailable");
    expect(screen.getAllByText("Unavailable")).toHaveLength(3);
    expect(screen.queryByText("private invalid payload")).toBeNull();
  });
});
