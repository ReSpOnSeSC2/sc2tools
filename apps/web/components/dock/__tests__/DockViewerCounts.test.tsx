import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DockChat } from "../DockChat";
import {
  formatViewers,
  sanitizeViewerCounts,
  type ViewerCounts,
} from "@/lib/multichat/useViewerCounts";
import type { MultichatConfig } from "@/lib/multichat/types";

const PLATFORMS: MultichatConfig = {
  twitch: { enabled: true, channel: "streamer" },
  kick: { enabled: true, channel: "streamer", chatroomId: 42 },
  youtube: { enabled: true, channel: "streamer" },
};

function renderDock(viewers?: ViewerCounts) {
  return render(
    <DockChat
      loaded
      platforms={PLATFORMS}
      messages={[]}
      statuses={{}}
      blockedUsers={[]}
      busy={false}
      viewers={viewers}
      onHighlight={vi.fn()}
      onBlock={vi.fn()}
    />,
  );
}

afterEach(cleanup);

describe("dock viewer counts", () => {
  it("shows each platform's count and the combined total", () => {
    renderDock({
      platforms: [
        { platform: "twitch", viewers: 1204, live: true },
        { platform: "kick", viewers: 87, live: true },
        { platform: "youtube", viewers: 9, live: true },
      ],
      total: 1300,
      partial: false,
      loaded: true,
    });

    expect(screen.getByTestId("dock-viewers-twitch").textContent).toBe("1,204");
    expect(screen.getByTestId("dock-viewers-kick").textContent).toBe("87");
    expect(screen.getByTestId("dock-viewers-youtube").textContent).toBe("9");

    const total = screen.getByTestId("dock-viewers-total");
    expect(total.textContent).toContain("1,300");
    expect(total.textContent).toContain("watching now");
    expect(total.getAttribute("title")).toBe(
      "1,300 currently watching across all platforms",
    );
  });

  it("renders nothing at all before the first response", () => {
    renderDock();
    expect(screen.queryByTestId("dock-viewers-total")).toBeNull();
    expect(screen.queryByTestId("dock-viewers-twitch")).toBeNull();
  });

  it("omits a platform whose count is unknown rather than showing a fake zero", () => {
    renderDock({
      platforms: [
        { platform: "twitch", viewers: 500, live: true },
        // Kick blocked by Cloudflare — unknown, not zero.
        { platform: "kick", viewers: null, live: false },
      ],
      total: 500,
      partial: true,
      loaded: true,
    });

    expect(screen.getByTestId("dock-viewers-twitch").textContent).toBe("500");
    expect(screen.queryByTestId("dock-viewers-kick")).toBeNull();
    // The total says "at least this many" when a platform is missing.
    const total = screen.getByTestId("dock-viewers-total");
    expect(total.textContent).toContain("500");
    expect(total.textContent).toContain("watching now+");
    expect(total.getAttribute("title")).toContain("at least one didn't report");
  });

  it("still shows a real zero when a platform is simply offline", () => {
    renderDock({
      platforms: [{ platform: "twitch", viewers: 0, live: false }],
      total: 0,
      partial: false,
      loaded: true,
    });
    expect(screen.getByTestId("dock-viewers-twitch").textContent).toBe("0");
    expect(screen.getByTestId("dock-viewers-total").textContent).toContain("0");
  });

  it("keeps the header readable at dock width by compacting big numbers", () => {
    expect(formatViewers(0)).toBe("0");
    expect(formatViewers(942)).toBe("942");
    expect(formatViewers(9_999)).toBe("9,999");
    expect(formatViewers(10_000)).toBe("10K");
    expect(formatViewers(12_345)).toBe("12.3K");
    expect(formatViewers(1_250_000)).toBe("1.3M");
  });
});

describe("sanitizeViewerCounts", () => {
  it("keeps real counts, drops junk, and recomputes the total from the parts", () => {
    const out = sanitizeViewerCounts({
      platforms: [
        { platform: "twitch", viewers: 100, live: true },
        { platform: "kick", viewers: null, live: false },
        { platform: "youtube", viewers: "12", live: true },
        { platform: "nowhere", viewers: 999, live: true },
        { platform: "twitch", viewers: 5, live: true },
        null,
      ],
      // Deliberately wrong: the parts are the truth.
      total: 9999,
    });

    expect(out.platforms).toEqual([
      { platform: "twitch", viewers: 100, live: true },
      { platform: "kick", viewers: null, live: false },
      { platform: "youtube", viewers: 12, live: true },
    ]);
    expect(out.total).toBe(112);
    expect(out.partial).toBe(true);
    expect(out.loaded).toBe(true);
  });

  it("keeps a valid per-platform observation time for raid reconciliation", () => {
    const out = sanitizeViewerCounts({
      platforms: [
        { platform: "twitch", viewers: 100, live: true, observedAtMs: 123456 },
        { platform: "kick", viewers: 10, live: true, observedAtMs: "bad" },
      ],
    });
    expect(out.platforms[0].observedAtMs).toBe(123456);
    expect(out.platforms[1].observedAtMs).toBeUndefined();
  });

  it("treats a negative or unparsable count as unknown", () => {
    const out = sanitizeViewerCounts({
      platforms: [
        { platform: "twitch", viewers: -3, live: true },
        { platform: "kick", viewers: "lots", live: true },
      ],
    });
    expect(out.platforms.map((p) => p.viewers)).toEqual([null, null]);
    expect(out.total).toBe(0);
    expect(out.partial).toBe(true);
  });

  it("survives a garbage body", () => {
    expect(sanitizeViewerCounts(null)).toMatchObject({
      platforms: [],
      total: 0,
      loaded: true,
    });
    expect(sanitizeViewerCounts({ platforms: "nope" })).toMatchObject({
      platforms: [],
      total: 0,
    });
  });
});
