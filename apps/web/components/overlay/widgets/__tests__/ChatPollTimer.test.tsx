import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChatPollWidget } from "../ChatPollWidget";

const h = vi.hoisted(() => ({
  config: vi.fn(),
  poll: { question: "Timed poll", options: ["A", "B"], startedAtMs: 20_000, status: "open", durationSec: 30, endsAtMs: 50_000 },
  messages: [
    { platform: "twitch", id: "early", user: "a", text: "1", badges: [], atMs: 49_999 },
    { platform: "twitch", id: "late", user: "b", text: "2", badges: [], atMs: 50_001 },
  ],
}));

vi.mock("@/lib/multichat/useStudioState", () => ({ useStudioState: () => ({ poll: h.poll, blockedUsers: [] }) }));
vi.mock("@/lib/multichat/useMultiChat", () => ({
  useMultiChat: ({ config }: { config: unknown }) => { h.config(config); return { messages: h.messages }; },
}));
vi.mock("@/lib/multichat/useTestFireFlag", () => ({ useTestFireFlag: () => false }));
vi.mock("../MultiChatWidget", () => ({ useMultichatConfig: () => ({ platforms: { twitch: { enabled: true, channel: "demo" } }, appearance: { blockedUsers: "" } }) }));

afterEach(() => { cleanup(); vi.useRealTimers(); h.config.mockClear(); });

it("counts down to the stamped deadline, settles accepted votes and closes the feed", () => {
  vi.useFakeTimers();
  vi.setSystemTime(40_000);
  render(<ChatPollWidget token="tok" />);
  expect(screen.getByText("0:10 left")).toBeTruthy();
  act(() => vi.advanceTimersByTime(10_000));
  expect(screen.getByText("FINAL")).toBeTruthy();
  expect(screen.getByText("1 vote")).toBeTruthy();
  act(() => vi.advanceTimersByTime(2_000));
  expect(h.config).toHaveBeenLastCalledWith(null);
});
