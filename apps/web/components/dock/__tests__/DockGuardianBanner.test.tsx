import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { GUARDIAN_EXPIRES_MS, type GuardianState } from "@/lib/multichat/streamGuardian";
import { DockGuardianBanner } from "../DockGuardianBanner";

afterEach(cleanup);
const NOW = 1_800_000_000_000;
const state = (overrides: Partial<GuardianState> = {}): GuardianState => ({
  warnings: [{ rule: "mic_muted", since: NOW - 150_000 }, { rule: "stuck_on_break", since: 0 }], receivedAt: NOW, ...overrides });

describe("DockGuardianBanner", () => {
  it("lists each active warning in a polite status region, with how long it has lasted when that is known", () => {
    render(<DockGuardianBanner guardian={state()} now={NOW} />);
    const alert = screen.getByRole("status", { name: "Stream Guardian warnings" });
    expect(alert.getAttribute("role")).toBe("status");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(alert.querySelector("ul")?.getAttribute("role")).toBeNull();
    expect(alert.querySelector("[aria-live]")).toBeNull();
    const rows = alert.querySelectorAll("li");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toBe("Your microphone has been muted for a while and you are live. For 3 min.");
    expect(rows[1].textContent).toBe("You are still live on a break scene, long after your last game.");
  });

  it.each([["nothing yet", null], ["no warnings", state({ warnings: [] })]])("renders nothing for %s", (_name, guardian) => {
    const { container } = render(<DockGuardianBanner guardian={guardian} now={NOW} />);
    expect(container.firstChild).toBeNull();
  });

  it("goes away when the agent stops refreshing the list", () => {
    const view = render(<DockGuardianBanner guardian={state()} now={NOW + GUARDIAN_EXPIRES_MS} />);
    expect(screen.getByRole("status")).toBeTruthy();
    view.rerender(<DockGuardianBanner guardian={state()} now={NOW + GUARDIAN_EXPIRES_MS + 1} />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("keeps the running minutes out of what a screen reader announces", () => {
    render(<DockGuardianBanner guardian={state()} now={NOW} />);
    const minutes = screen.getByRole("status").querySelector("li span");
    expect(minutes?.getAttribute("aria-hidden")).toBe("true");
    expect(minutes?.textContent).toBe(" For 3 min.");
  });
});
