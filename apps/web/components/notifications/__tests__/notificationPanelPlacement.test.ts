import { describe, expect, it } from "vitest";
import { notificationPanelPlacement } from "../NotificationBell";

describe("notificationPanelPlacement", () => {
  it("keeps the panel on screen when the bell sits mid-header on a phone", () => {
    // 412px phone: bell at 300–340, theme toggle + avatar to its right.
    const { left, width } = notificationPanelPlacement({ left: 300, right: 340 }, 412);
    expect(width).toBe(352);
    const viewportLeft = 300 + left;
    expect(viewportLeft).toBe(16);
    expect(viewportLeft + width).toBeLessThanOrEqual(412 - 16);
  });

  it("right-aligns to the bell when there is room", () => {
    const { left, width } = notificationPanelPlacement({ left: 1100, right: 1136 }, 1440);
    expect(width).toBe(352);
    expect(1100 + left + width).toBe(1136);
  });

  it("shrinks to fit a narrow phone with a 16px gutter each side", () => {
    const { left, width } = notificationPanelPlacement({ left: 250, right: 282 }, 360);
    expect(width).toBe(328);
    expect(250 + left).toBe(16);
  });

  it("never runs past the right edge", () => {
    const { left, width } = notificationPanelPlacement({ left: 390, right: 420 }, 430);
    expect(390 + left + width).toBe(430 - 16);
  });
});
