import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LiveScoutingScreen } from "./LiveScoutingScreen";
vi.mock("./useLiveScouting", () => ({ useLiveScouting: () => ({ live: null, unavailable: false, connected: true }) }));
vi.mock("./ScoutingBriefCard", () => ({ ScoutingBriefCard: () => <p>Waiting fixture</p> }));
vi.mock("@/components/help/LazyHelpLink", () => ({ LazyHelpLink: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }));
const original = Object.getOwnPropertyDescriptor(navigator, "wakeLock");
afterEach(() => { cleanup(); if (original) Object.defineProperty(navigator, "wakeLock", original); else Reflect.deleteProperty(navigator, "wakeLock"); });
describe("second-screen wake lock", () => {
  it("keeps scouting usable if the browser declines a wake lock", async () => {
    Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request: vi.fn().mockRejectedValue(new Error("Denied")) } });
    render(<LiveScoutingScreen />);
    expect(await screen.findByText(/your browser controls sleep/)).toBeTruthy(); expect(screen.getByText("Waiting fixture")).toBeTruthy();
  });
  it("releases the acquired screen lock on toggle and unmount without duplicate requests", async () => {
    const release = vi.fn(async () => {}), lock = Object.assign(new EventTarget(), { released: false, release });
    const request = vi.fn(async () => lock); Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request } });
    const view = render(<LiveScoutingScreen />); await waitFor(() => expect(screen.getByText(/Keeping this screen awake/)).toBeTruthy());
    act(() => document.dispatchEvent(new Event("visibilitychange"))); expect(request).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Keep screen awake" })); expect(release).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Keep screen awake" }).getAttribute("aria-pressed")).toBe("false");
    view.unmount(); expect(release).toHaveBeenCalledOnce();
  });
  it("releases a lock that arrives after the screen has closed", async () => {
    let finish!: (value: unknown) => void; const release = vi.fn(async () => {});
    Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request: () => new Promise(resolve => { finish = resolve; }) } });
    const view = render(<LiveScoutingScreen />); view.unmount(); await act(async () => finish({ release })); expect(release).toHaveBeenCalledOnce();
  });
});
