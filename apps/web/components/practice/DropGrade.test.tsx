// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DropGrade } from "./DropGrade";
import { desktopChromium } from "./PracticeLinkTabs";

const { session, options } = vi.hoisted(() => ({
  session: { phase: "idle", busy: false, error: null, failed: [], parsed: [], candidates: [],
    reset: vi.fn(), addFiles: vi.fn(async () => {}), start: vi.fn(async () => {}), choose: vi.fn() },
  options: vi.fn(),
}));
vi.mock("@/lib/instant/useInstantSession", () => ({ SINGLE_REPLAY_SESSION_OPTIONS: {}, useInstantSession: (value: unknown) => { options(value); return session; } }));

const target = { v: 1 as const, name: "Opening", steps: [{ t: 10, supply: 14, name: "Pylon" }] };
const props = { target, race: "Protoss", era: "before", credit: { title: "Opening", creator: "Fixture creator", path: "/b/opening" } } as const;
afterEach(() => { cleanup(); vi.clearAllMocks(); session.phase = "idle"; });

describe("Practice Link replay intake", () => {
  it("admits desktop Chromium and excludes mobile and Safari", () => {
    expect(desktopChromium("Mozilla Windows NT 10.0 Chrome/140.0", 10)).toBe(true);
    expect(desktopChromium("Mozilla Android Chrome/140.0 Mobile", 5)).toBe(false);
    expect(desktopChromium("Mozilla Android Chrome/140.0", 5)).toBe(false);
    expect(desktopChromium("Mozilla Macintosh Chrome/140.0", 5)).toBe(false);
    expect(desktopChromium("Mozilla Version/26 Safari/607.1", 0)).toBe(false);
  });

  it("starts the local session only after one replay is selected", async () => {
    render(<DropGrade {...props} />);
    expect(options).toHaveBeenCalledWith(expect.objectContaining({ trackAnalytics: false }));
    const region = screen.getByRole("region", { name: "Grade a replay" });
    const replay = new File(["fixture"], "local.SC2Replay");
    expect(session.start).not.toHaveBeenCalled();
    fireEvent.drop(region, { dataTransfer: { types: ["Files"], files: [replay, replay] } });
    expect(screen.getByRole("alert").textContent).toContain("exactly one");
    expect(session.addFiles).not.toHaveBeenCalled();
    fireEvent.drop(region, { dataTransfer: { types: ["Files"], files: [replay] } });
    await waitFor(() => expect(session.start).toHaveBeenCalledTimes(1));
    expect(session.addFiles).toHaveBeenCalledWith([replay], "drop");
  });

  it("returns focus to replay intake when retrying", async () => {
    const { rerender } = render(<DropGrade {...props} />);
    const region = screen.getByRole("region", { name: "Grade a replay" });
    const replay = new File(["fixture"], "local.SC2Replay");
    fireEvent.drop(region, { dataTransfer: { types: ["Files"], files: [replay] } });
    await waitFor(() => expect(session.start).toHaveBeenCalledTimes(1));
    session.phase = "done";
    rerender(<DropGrade {...props} />);
    const retry = screen.getByRole("button", { name: "Try again" });
    retry.focus();
    fireEvent.click(retry);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Choose a replay" }));
    await waitFor(() => expect(session.start).toHaveBeenCalledTimes(2));
  });
});
