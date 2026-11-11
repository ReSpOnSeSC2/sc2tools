import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ClipFlagWidget } from "../ClipFlagWidget";
import { OverlayPreviewContext } from "@/lib/overlayPreviewContext";

const { engagement } = vi.hoisted(() => ({ engagement: { lastEvent: null as unknown } }));
vi.mock("@/lib/multichat/useEngagementState", () => ({ useEngagementState: () => engagement }));
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("keeps manual Dock notes off the stream and lets a visible auto clip expire", () => {
  vi.useFakeTimers();
  const moment = (kind: string, reason: string) => ({ type: "clip-moment", moment: { kind, reason } });
  const widget = () => <OverlayPreviewContext.Provider value={false}><ClipFlagWidget token="private-dock" /></OverlayPreviewContext.Provider>;
  engagement.lastEvent = moment("manual", "Personal reminder");
  const view = render(widget());
  expect(screen.queryByText("Personal reminder")).toBeNull();
  expect(screen.queryByText("CLIP THAT!")).toBeNull();
  engagement.lastEvent = moment("chat-spike", "Chat is cheering");
  view.rerender(widget());
  expect(screen.getByText("Chat is cheering")).toBeTruthy();
  engagement.lastEvent = moment("manual", "Private follow-up");
  view.rerender(widget());
  expect(screen.queryByText("Private follow-up")).toBeNull();
  act(() => vi.advanceTimersByTime(20_000));
  expect(screen.queryByText("Chat is cheering")).toBeNull();
});
