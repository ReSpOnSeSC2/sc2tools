import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SWRConfig } from "swr";
import { OverlayHealthProvider } from "@/components/overlay/OverlayHealthContext";
import { OverlayHealthBoard, WidgetPresenceBadge } from "../OverlayHealthBoard";
const { auth } = vi.hoisted(() => ({ auth: { isLoaded: true, isSignedIn: true, userId: "owner", getToken: vi.fn(async () => "owner-jwt") } }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => auth }));
const fetchSpy = vi.fn();
const payload = () => ({ surfaces: { "all-in-one": { count: 1 }, dock: { count: 1 }, unknown: { count: 1 } }, widgets: { scouting: { count: 1 } }, scenes: {}, agent: { online: true }, totalSources: 4, sampledAt: new Date().toISOString(), lastLiveAt: null });
function Fixture({ token = "synthetic-token", enabled = true }: { token?: string; enabled?: boolean }) {
  return <SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false }}><OverlayHealthProvider token={token} enabled={enabled} enabledWidgets={["multichat"]}><OverlayHealthBoard token={{ token, enabledWidgets: ["multichat"] }} /><WidgetPresenceBadge widget="scouting" enabled /></OverlayHealthProvider></SWRConfig>;
}
beforeEach(() => {
  auth.isLoaded = true; auth.isSignedIn = true; auth.userId = "owner"; auth.getToken.mockResolvedValue("owner-jwt");
  fetchSpy.mockReset(); fetchSpy.mockImplementation(async (input: string) => {
    if (input.endsWith("/v1/devices")) return Response.json({ items: [{ lastSeenAt: new Date().toISOString() }] });
    if (input.endsWith("/v1/me/preferences/multichat")) return Response.json({ twitch: { enabled: true } });
    return Response.json(payload());
  });
  vi.stubGlobal("fetch", fetchSpy); vi.stubGlobal("IntersectionObserver", undefined);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe("shared visible overlay health", () => {
  it("fetches once for the checklist and all card badges, without exposing credentials", async () => {
    render(<Fixture />); expect(await screen.findByText("Duplicate audio · 2 sources")).toBeTruthy();
    expect(await screen.findByText("Seen just now")).toBeTruthy(); expect(screen.getByText(/1 unknown source/)).toBeTruthy();
    expect(fetchSpy).toHaveBeenCalledTimes(3); expect(document.body.textContent).not.toContain("synthetic-token");
    expect(screen.getByText("Chat platform configured").closest("li")?.textContent).toContain("1 platform enabled");
    expect(fetchSpy.mock.calls.filter(([path]) => path.endsWith("/v1/overlay-tokens/synthetic-token/presence"))).toHaveLength(1);
  });
  it("does no work for a hidden Settings section or a source outside the viewport", async () => {
    let intersect: (entries: { isIntersecting: boolean }[]) => void = () => undefined;
    vi.stubGlobal("IntersectionObserver", class { constructor(callback: typeof intersect) { intersect = callback; } observe() {} disconnect() {} });
    const view = render(<Fixture enabled={false} />); await act(async () => {}); expect(fetchSpy).not.toHaveBeenCalled();
    view.rerender(<Fixture enabled />); await act(async () => {}); expect(fetchSpy).not.toHaveBeenCalled();
    await act(async () => intersect([{ isIntersecting: true }]));
    expect(await screen.findByText("Duplicate audio · 2 sources")).toBeTruthy(); expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
  it("withholds a previous owner's data through loading and signed-out auth phases", async () => {
    const view = render(<Fixture />); await screen.findByText("Duplicate audio · 2 sources");
    auth.isLoaded = false; view.rerender(<Fixture />); expect(screen.queryByText("Duplicate audio · 2 sources")).toBeNull();
    auth.isLoaded = true; auth.isSignedIn = false; view.rerender(<Fixture />); expect(screen.queryByText("Seen just now")).toBeNull();
  });
  it("settles a held token at the request deadline and never fetches after its late release", async () => {
    vi.useFakeTimers(); let release: (token: string) => void = () => undefined;
    auth.getToken.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    render(<Fixture />); await act(async () => {});
    await act(async () => vi.advanceTimersByTimeAsync(10_001));
    expect(screen.getByText(/Couldn’t refresh source connections/)).toBeTruthy();
    await act(async () => release("late-jwt")); expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("offers a real refresh after a failed sample and never marks stale counts ready", async () => {
    const respond = fetchSpy.getMockImplementation()!;
    let fail = true;
    fetchSpy.mockImplementation(async (input: string) => {
      if (fail && input.endsWith("/presence")) { fail = false; return new Response("unavailable", { status: 503 }); }
      return respond(input);
    });
    render(<Fixture />); await screen.findByText(/Couldn’t refresh source connections/);
    fireEvent.click(screen.getByRole("button", { name: "Refresh sources" }));
    expect(await screen.findByText("Duplicate audio · 2 sources")).toBeTruthy();
  });
  it("stops polling while the document is hidden and resumes on return", async () => {
    vi.useFakeTimers();
    let hidden = false; vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => hidden ? "hidden" : "visible");
    render(<Fixture />); await act(async () => vi.advanceTimersByTimeAsync(50));
    expect(screen.getByText("Duplicate audio · 2 sources")).toBeTruthy();
    hidden = true; act(() => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => vi.advanceTimersByTimeAsync(45_000)); expect(fetchSpy).toHaveBeenCalledTimes(3);
    hidden = false; await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => vi.advanceTimersByTimeAsync(50));
    expect(fetchSpy).toHaveBeenCalledTimes(6);
  });
});
