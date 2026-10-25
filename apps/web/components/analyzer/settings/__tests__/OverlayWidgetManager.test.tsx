import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ query: "section=widgets", userId: "owner-a", replace: vi.fn(), api: vi.fn(), sent: [] as unknown[], getToken: vi.fn(), updated: vi.fn() }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(state.query), useRouter: () => ({ replace: state.replace }) }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ userId: state.userId, getToken: state.getToken }) }));
vi.mock("@/lib/clientApi", () => ({ apiCall: (...args: unknown[]) => state.api(...args) }));
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
  expect(view.container.querySelectorAll("[data-widget-id]")).toHaveLength(31);
  fireEvent.click(screen.getByRole("checkbox", { name: "Enabled only" })); expect(view.container.querySelectorAll("[data-widget-id]")).toHaveLength(3);
  fireEvent.change(screen.getByRole("searchbox", { name: "Find a widget" }), { target: { value: "session" } }); expect(view.container.querySelectorAll("[data-widget-id]")).toHaveLength(1);
  const card = screen.getByRole("heading", { name: /^Session record$/ }).closest("article")!;
  expect(within(card).getByText("Recommended 480 × 360")).toBeTruthy();
  const href = within(card).getByRole("link", { name: "Drag into OBS" }).getAttribute("href")!;
  const query = new URL(href).searchParams; expect(query.get("layer-width")).toBe("480"); expect(query.get("layer-name")).toContain("Session record");
  expect(card.querySelector("code")!.textContent).not.toContain(token.token);
  fireEvent.click(within(card).getByRole("switch", { name: "Enable Session record" })); expect(props.onToggleWidget).toHaveBeenCalledWith("session", false);
});
it("retains theme and Ghost data when adding the documented OBS URL-drop parameters", () => {
  const parsed = new URL(obsWidgetDropUrl("https://example.invalid/overlay/synthetic/widget/ghost-build?theme=abc#ghost=private", "Ghost", 640, 900));
  expect(parsed.searchParams.get("theme")).toBe("abc"); expect(parsed.searchParams.get("layer-height")).toBe("900"); expect(parsed.hash).toBe("#ghost=private");
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
it("uses the query as the section authority and retains shareable navigation links", () => {
  function Preview() { const section = useOverlaySection(); return <OverlayManagerNav section={section} />; }
  state.query = "tab=overlay&section=look"; render(<Preview />); expect(screen.getByRole("link", { name: /^Look$/ }).getAttribute("aria-current")).toBe("page");
  expect(screen.getByRole("link", { name: "Dock & bot" }).getAttribute("href")).toContain("section=dock");
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
