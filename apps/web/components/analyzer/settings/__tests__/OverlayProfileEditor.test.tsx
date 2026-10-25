import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { OverlayProfileEditor } from "../OverlayProfileEditor";
import { OverlayThemeSection } from "../OverlayThemeSection";
import { OverlayWidgetDisplay } from "../OverlayWidgetDisplay";
import { SettingsContextProvider } from "../SettingsContext";
import type { OverlayToken } from "../OverlayTokenHeader";

const auth = vi.hoisted(() => ({ userId: "owner-a", isLoaded: true, isSignedIn: true, getToken: vi.fn(async () => "synthetic-jwt") }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => auth }));
const token = (over: Partial<OverlayToken> = {}): OverlayToken => ({ token: "synthetic-token", label: "Main", createdAt: "2026-10-25", ...over });
const saved = vi.fn(), dirties = vi.fn();
function Fixture({ value = token() }: { value?: OverlayToken }) {
  return <SettingsContextProvider onDirtyChange={dirties}><OverlayProfileEditor key={`${auth.userId}:${value.token}`} token={value} onSaved={saved}>{({ profile, setTheme, setDuration, saving }) => <>
    <OverlayThemeSection theme={profile.theme} onChange={setTheme} />
    <OverlayWidgetDisplay id="scouting" name="Scouting" durationSec={profile.widgetOptions.scouting?.durationSec} onChange={seconds => setDuration("scouting", seconds)} disabled={saving} />
    <OverlayWidgetDisplay id="session" name="Session" onChange={seconds => setDuration("session", seconds)} disabled={saving} />
    <output data-testid="draft">{JSON.stringify(profile)}</output>
  </>}</OverlayProfileEditor></SettingsContextProvider>;
}
function changeDuration(value: string) {
  if (!screen.queryByLabelText("Display time for Scouting")) fireEvent.click(screen.getByRole("button", { name: "Display for Scouting" }));
  fireEvent.change(screen.getByLabelText("Display time for Scouting"), { target: { value } });
}
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  localStorage.clear(); saved.mockClear(); dirties.mockClear(); auth.userId = "owner-a"; auth.isLoaded = auth.isSignedIn = true; auth.getToken.mockResolvedValue("synthetic-jwt");
  fetchMock = vi.fn(async (_url: string, init: RequestInit) => { const body = JSON.parse(init.body as string); return { ok: true, status: 200, json: async () => ({ profile: body.profile, profileRevision: body.expectedRevision + 1 }) }; });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("saved overlay display draft", () => {
  it("loads a server theme without making a write and combines Look + Display in one explicit CAS save", async () => {
    render(<Fixture value={token({ profile: { v: 1, theme: { accent: "#123456" }, widgetOptions: {} }, profileRevision: 7 })} />);
    expect((screen.getByLabelText("Accent hex value") as HTMLInputElement).value).toBe("#123456"); expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Accent hex value"), { target: { value: "#abcdef" } });
    changeDuration("45");
    expect(dirties).toHaveBeenLastCalledWith({ overlay: true }); expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save overlay display" }));
    await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0]; expect(url).toContain("/v1/overlay-tokens/synthetic-token/profile");
    expect(JSON.parse(init.body as string)).toEqual({ expectedRevision: 7, profile: { v: 1, theme: { accent: "#abcdef" }, widgetOptions: { scouting: { durationSec: 45 } } } });
    await waitFor(() => expect(screen.queryByRole("region", { name: "Unsaved changes" })).toBeNull());
    expect(localStorage.getItem("sc2tools:overlay-theme:synthetic-token")).toBeNull();
    expect(screen.getByText("Default (15s)")).toBeTruthy();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Display for Session" })); fireEvent.click(screen.getByRole("button", { name: "Display for Session" }));
    expect((screen.getByLabelText("Display time for Session") as HTMLSelectElement).disabled).toBe(true);
  });
  it("offers a legacy theme only as an opt-in draft, with no automatic persistent profile write", async () => {
    localStorage.setItem("sc2tools:overlay-theme:synthetic-token", JSON.stringify({ accent: "#abcdef", unknown: "unsafe" }));
    const view = render(<Fixture />); expect(screen.getByRole("heading", { name: "Move your theme to your overlay" })).toBeTruthy();
    expect((screen.getByLabelText("Accent hex value") as HTMLInputElement).value).toBe(""); expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Use previous theme" }));
    expect((screen.getByLabelText("Accent hex value") as HTMLInputElement).value).toBe("#abcdef"); expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect((screen.getByLabelText("Accent hex value") as HTMLInputElement).value).toBe(""); view.unmount();
    render(<Fixture />); expect(screen.queryByRole("heading", { name: "Move your theme to your overlay" })).toBeNull(); expect(fetchMock).not.toHaveBeenCalled();
  });
  it("keeps a stale draft on CAS conflict without overwriting a different tab's profile", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { code: "overlay_profile_changed", message: "Changed" } }), { status: 409 }));
    const view = render(<Fixture value={token({ profileRevision: 2 })} />);
    changeDuration("30");
    view.rerender(<Fixture value={token({ profileRevision: 3, profile: { v: 1, theme: { accent: "#123456" }, widgetOptions: {} } })} />);
    fireEvent.click(screen.getByRole("button", { name: "Save overlay display" }));
    await waitFor(() => expect(screen.getByText(/This overlay changed in another tab/)).toBeTruthy());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).expectedRevision).toBe(2);
    expect((screen.getByLabelText("Display time for Scouting") as HTMLSelectElement).value).toBe("30"); expect(saved).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Discard" })); expect((screen.getByLabelText("Accent hex value") as HTMLInputElement).value).toBe("#123456");
  });
  it("drops a previous owner's pending token lookup and draft before any request can be sent", async () => {
    let release!: (jwt: string) => void; auth.getToken.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const view = render(<Fixture />); changeDuration("60"); fireEvent.click(screen.getByRole("button", { name: "Save overlay display" }));
    auth.userId = "owner-b"; view.rerender(<Fixture value={token({ token: "other-token" })} />);
    await act(async () => release("old-jwt"));
    expect(fetchMock).not.toHaveBeenCalled(); expect(saved).not.toHaveBeenCalled(); expect(screen.getByTestId("draft").textContent).not.toContain("60");
  });
  it("ignores a prior owner's late successful response and aborts its signal", async () => {
    let finish!: (response: unknown) => void; fetchMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const view = render(<Fixture />); changeDuration("60"); fireEvent.click(screen.getByRole("button", { name: "Save overlay display" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1)); const signal = fetchMock.mock.calls[0][1].signal;
    auth.userId = "owner-b"; view.rerender(<Fixture value={token({ token: "other-token" })} />);
    expect(signal?.aborted).toBe(true);
    await act(async () => finish({ ok: true, status: 200, json: async () => ({ profile: { v: 1, theme: { accent: "#000" }, widgetOptions: {} }, profileRevision: 1 }) }));
    expect(saved).not.toHaveBeenCalled(); expect(screen.getByTestId("draft").textContent).not.toContain("#000");
  });
  it("settles a stalled authentication lookup at the save deadline and retains the draft", async () => {
    vi.useFakeTimers(); auth.getToken.mockImplementationOnce(() => new Promise(() => {}));
    render(<Fixture />); changeDuration("60"); fireEvent.click(screen.getByRole("button", { name: "Save overlay display" }));
    await act(async () => vi.advanceTimersByTimeAsync(20_001));
    expect(screen.getByText(/Saving the overlay took too long/)).toBeTruthy(); expect(fetchMock).not.toHaveBeenCalled();
    expect((screen.getByLabelText("Display time for Scouting") as HTMLSelectElement).value).toBe("60");
    expect((screen.getByRole("button", { name: "Save overlay display" }) as HTMLButtonElement).disabled).toBe(false);
  });

});
