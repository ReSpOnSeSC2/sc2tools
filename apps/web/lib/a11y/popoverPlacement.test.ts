import { expect, it } from "vitest";
import { notificationPanelPlacement, popoverPlacement } from "./popoverPlacement";

it("keeps the notification clamp's existing relative placement", () => {
  expect(notificationPanelPlacement({ left: 300, right: 344 }, 360)).toEqual({ left: -284, width: 328 });
  expect(notificationPanelPlacement({ left: 1200, right: 1244 }, 1280)).toEqual({ left: -308, width: 352 });
});
it.each([-200, 900])("keeps a large panel inside the viewport when its anchor scrolls to %s", top => {
  const placement = popoverPlacement({ left: 10, right: 80, top, bottom: top + 44 }, 800, { width: 320, height: 700 });
  expect(placement.maxHeight).toBeLessThanOrEqual(668);
  expect(placement.top).toBeGreaterThanOrEqual(16);
  expect(placement.top + placement.maxHeight).toBeLessThanOrEqual(684);
});
it("fits narrow viewports and flips above a low trigger", () => {
  expect(popoverPlacement({ left: 320, right: 364, top: 700, bottom: 744 }, 300, { width: 360, height: 800 })).toEqual({ left: 16, top: 392, width: 328, maxHeight: 676 });
  const tiny = popoverPlacement({ left: 0, right: 44, top: 0, bottom: 44 }, 50, { width: 20, height: 20 });
  expect(tiny.width).toBe(0); expect(tiny.maxHeight).toBe(0); expect(tiny.left).toBe(10); expect(tiny.top).toBe(10);
});
