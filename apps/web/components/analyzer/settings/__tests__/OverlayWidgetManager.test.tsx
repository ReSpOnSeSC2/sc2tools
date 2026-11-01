import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ query: "section=widgets", userId: "owner-a", replace: vi.fn(), api: vi.fn(), sent: [] as unknown[], getToken: vi.fn(), updated: vi.fn() }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(state.query), useRouter: () => ({ replace: state.replace }) }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ userId: state.userId, getToken: state.getToken }) }));
vi.mock("@/lib/clientApi", () => ({ apiCall: (...args: unknown[]) => state.api(...args), useApi: () => ({ data: { devices: [] }, mutate: vi.fn() }) }));
vi.mock("next/image", () => ({ default: ({ alt }: { alt: string }) => <span role="img" aria-label={alt} /> }));
import { WidgetList, obsWidgetDropUrl } from "../OverlayWidgetGrid";
import { OverlayStarterPacks } from "../OverlayStarterPacks";
import { OverlayManagerNav, useOverlaySection } from "../OverlayManagerNav";
const token = { token: "synthetic-private", label: "Local", createdAt: "2026-10-25", enabledWidgets: ["session", "randomizer"] };
const props = { token, origin: "https://sc2tools.example", theme: {}, ghostConfig: { v: 2 as const, slots: {} }, busy: false, onToggleWidget: vi.fn(), onTestWidget: vi.fn(), testingWidget: null };
beforeEach(() => {
  state.query = "section=widgets"; state.userId = "owner-a"; state.replace.mockReset(); state.updated.mockReset().mockResolvedValue(undefined); state.sent = []; state.getToken.mockReset().mockResolvedValue("synthetic-auth");
  state.api.mockReset().mockImplementation(async (getToken, path, options) => { await getToken(); state.sent.push({ path, options }); return { enabledWidgets: [] }; });
  vi.stubGlobal("matchMedia", () => ({ matches: true })); Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("groups and searches real widget cards, filters enabled items, and keeps unknown IDs harmless", () => {
  state.query += "&widget=unknown"; const view = render(<WidgetList {...props} />);
  expect(view.container.querySelectorAll("[data-widget-id]")).toHaveLength(32);
  const series = view.container.querySelector('[data-widget-id="series"]') as HTMLElement;
  expect(within(series).getByRole("switch", { name: "Enable Series scoreboard" }).getAttribute("aria-checked")).toBe("false");
  fireEvent.click(screen.getByRole("checkbox", { name: "Enabled only" })); expect(view.container.querySelectorAll("[data-widget-id]")).toHaveLength(3);
  fireEvent.change(screen.getByRole("searchbox", { name: "Find a widget" }), { target: { value: "session" } }); expect(view.container.querySelectorAll("[data-widget-id]")).toHaveLength(1);
  const card = screen.getByRole("heading", { name: /^Session record$/ }).closest("article")!;
  expect(within(card).getByText("Recommended 480 × 360")).toBeTruthy();
  const href = within(card).getByRole("link", { name: "Drag into OBS" }).getAttribute("href")!;
  const query = new URL(href).searchParams; expect(query.get("layer-width")).toBe("480"); expect(query.get("layer-name")).toContain("Session record");
  expect(card.querySelector("code")!.textContent).not.toContain(token.token);
  fireEvent.click(within(card).getByRole("switch", { name: "Enable Session record" })); expect(props.onToggleWidget).toHaveBeenCalledWith("session", false);
});
it("explains Session record and Best answer beside their headings with their own terms", async () => {
  const view = render(<WidgetList {...props} />);
  const session = view.container.querySelector('[data-widget-id="session"]') as HTMLElement;
  const best = view.container.querySelector('[data-widget-id="best-answer"]') as HTMLElement;
  expect(within(session).getByRole("heading", { name: /^Session record$/ })).toBeTruthy();
  expect(within(session).getByRole("button", { name: "About Session record" }).closest("h4")).toBeNull();
  expect(within(session).getByText("A persistent scorecard for your current session's games and current MMR.")).toBeTruthy();
  expect(within(view.container.querySelector('[data-widget-id="series"]') as HTMLElement).queryByRole("button", { name: /^About / })).toBeNull();
  for (const [card, name, term] of [[session, "About Session record", "overlay-session"], [best, "About Best answer", "best-answer"]] as const) {
    fireEvent.click(within(card).getByRole("button", { name }));
    const opened = await screen.findByRole("dialog", { name });
    expect((await within(opened).findByRole("link", { name: "Learn more" })).getAttribute("href")).toBe(`/help/glossary#${term}`);
    fireEvent.keyDown(opened, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name })).toBeNull());
  }
});
it("retains theme and Ghost data when adding the documented OBS URL-drop parameters", () => {
  const parsed = new URL(obsWidgetDropUrl("https://example.invalid/overlay/synthetic/widget/ghost-build?theme=abc#ghost=private", "Ghost", 640, 900));
  expect(parsed.searchParams.get("theme")).toBe("abc"); expect(parsed.searchParams.get("layer-height")).toBe("900"); expect(parsed.hash).toBe("#ghost=private");
});
it("new Ghost source URLs remain permanent when account assignments change", () => {
  const target = { v: 1 as const, name: "First", steps: [{ supply: null, t: 30, name: "Gateway" }] };
  const view = render(<WidgetList {...props} ghostConfig={{ v: 2, slots: { PvT: target } }} />);
  const href = () => within(view.container.querySelector('[data-widget-id="ghost-build"]') as HTMLElement).getByRole("link", { name: "Drag into OBS" }).getAttribute("href");
  const original = href(); expect(new URL(original!).hash).toBe("");
  view.rerender(<WidgetList {...props} ghostConfig={{ v: 2, slots: { PvT: { ...target, name: "Other browser" } } }} />);
  expect(href()).toBe(original);
});
it("deep links focus Copy for the requested widget", async () => {
  state.query += "&widget=scouting"; const view = render(<WidgetList {...props} />);
  await waitFor(() => expect(document.activeElement).toBe(view.container.querySelector('[data-widget-id="scouting"] [data-widget-copy]')));
});
it("opens a pack review without writing and removes the URL pack on Cancel", () => {
  state.query += "&pack=first-stream"; render(<OverlayStarterPacks token={token} onUpdated={state.updated} />);
  const dialog = screen.getByRole("dialog"); expect(dialog.textContent).toContain("Session record — already enabled"); expect(dialog.textContent).toContain("Opponent identity — will be enabled");
  expect(state.api).not.toHaveBeenCalled(); fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(new URL(state.replace.mock.calls[0][0], "https://example.invalid").searchParams.has("pack")).toBe(false); expect(state.sent).toEqual([]);
});
it("retains other enabled widgets and sends the reviewed baseline for conflict detection", async () => {
  state.query += "&pack=first-stream"; render(<OverlayStarterPacks token={token} onUpdated={state.updated} />);
  fireEvent.click(screen.getByRole("button", { name: /^Enable setup$/ }));
  await waitFor(() => expect(state.updated).toHaveBeenCalledOnce());
  const body = JSON.parse((state.sent[0] as { options: { body: string } }).options.body); expect(body.enabled).toEqual(["session", "randomizer", "opponent", "match-result"]); expect(body.expectedEnabled).toEqual(token.enabledWidgets);
});
it("does not send a delayed authenticated mutation after the owner changes", async () => {
  state.query += "&pack=community"; let release!: (value: string) => void; state.getToken.mockImplementationOnce(() => new Promise<string>(resolve => { release = resolve; }));
  const view = render(<OverlayStarterPacks token={token} onUpdated={state.updated} />); fireEvent.click(screen.getByRole("button", { name: /^Enable setup$/ }));
  state.userId = "owner-b"; view.rerender(<OverlayStarterPacks token={token} onUpdated={state.updated} />); await act(async () => release("synthetic-auth"));
  expect(state.sent).toEqual([]); expect(state.updated).not.toHaveBeenCalled();
});
it("accepts an old Look query hint while navigation uses canonical real-section links", () => {
  function Preview() { const section = useOverlaySection(); return <><p>Pane hint: {section}</p><OverlayManagerNav scope={{ current: null }} hash="#theme" onNavigate={vi.fn()} /></>; }
  state.query = "tab=overlay&section=look"; render(<Preview />); expect(screen.getByText("Pane hint: look")).toBeTruthy();
  expect(screen.getByRole("link", { name: /^Theme$/ }).getAttribute("aria-current")).toBe("location");
  expect(screen.getAllByRole("link").map(link => link.textContent)).toEqual(["Setup", "Widgets", "Scenes", "Build profile", "Ghost Build coach", "Theme", "Tokens"]);
  expect(screen.queryByRole("link", { name: "Dock & bot" })).toBeNull();
  expect(screen.queryByRole("link", { name: "Chat & alerts" })).toBeNull();
});


it("new copies follow the saved profile and each real card exposes the shared duration choices", () => {
  const change = vi.fn(); const view = render(<WidgetList {...props} theme={{ accent: "#abcdef" }} profile={{ v: 1, theme: {}, widgetOptions: { scouting: { durationSec: 45 } } }} onDurationChange={change} />);
  const card = view.container.querySelector('[data-widget-id="scouting"]')!;
  expect(new URL(within(card as HTMLElement).getByRole("link", { name: "Drag into OBS" }).getAttribute("href")!).searchParams.has("theme")).toBe(false);
  fireEvent.click(within(card as HTMLElement).getByRole("button", { name: "Display for Scouting tells" }));
  const select = screen.getByLabelText("Display time for Scouting tells") as HTMLSelectElement;
  expect(select.value).toBe("45"); fireEvent.change(select, { target: { value: "" } }); expect(change).toHaveBeenCalledWith("scouting", null);
  fireEvent.pointerDown(screen.getByRole("button", { name: "Display for Session record" })); fireEvent.click(screen.getByRole("button", { name: "Display for Session record" }));
  expect((screen.getByLabelText("Display time for Session record") as HTMLSelectElement).disabled).toBe(true);
});
