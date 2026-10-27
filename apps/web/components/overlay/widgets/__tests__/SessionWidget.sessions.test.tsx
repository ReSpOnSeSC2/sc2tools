import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { SessionWidget } from "../SessionWidget";
import type { LiveGamePayload } from "../../types";
vi.mock("../../WidgetShell", () => ({ WidgetShell: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
afterEach(() => { cleanup(); vi.useRealTimers(); });
it("shows the admitted definition with no active elapsed clock", () => {
  render(<SessionWidget live={null} session={{ wins: 0, losses: 0, games: 0, sessionGapMinutes: 90, sessionPolicySource: "auto-player" }} />);
  expect(screen.getByText("gap >90m")).toBeTruthy();
});
it("does not invent a definition for legacy payloads without metadata", () => {
  render(<SessionWidget live={null} session={{ wins: 1, losses: 0, games: 1 }} />);
  expect(screen.queryByText(/gap >/)).toBeNull();
});
it("retains the elapsed clock and cleans its existing interval on unmount", () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-27T12:30:00Z"));
  const view = render(<SessionWidget live={null} session={{ wins: 1, losses: 0, games: 1,
    sessionStartedAt: "2026-10-27T12:00:00Z", sessionGapMinutes: 240, sessionPolicySource: "auto-overlay" }} />);
  expect(screen.getByText("30m · gap >240m")).toBeTruthy(); expect(vi.getTimerCount()).toBe(1);
  view.unmount(); expect(vi.getTimerCount()).toBe(0);
});

it("renders optional metadata through the typed legacy live.session fallback", () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-27T12:30:00Z"));
  const live: LiveGamePayload = { session: { wins: 2, losses: 1, games: 3,
    sessionStartedAt: "2026-10-27T12:00:00Z", sessionGapMinutes: 45,
    sessionPolicySource: "preference", storedSessionGapMinutes: 45 } };
  const view = render(<SessionWidget live={live} />);
  expect(screen.getByText("30m · gap >45m")).toBeTruthy();
  expect(vi.getTimerCount()).toBe(1);
  view.unmount(); expect(vi.getTimerCount()).toBe(0);
});