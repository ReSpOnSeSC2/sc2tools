import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SWRConfig } from "swr";
import type { ReactNode } from "react";
import type { DiscordHook } from "../DiscordSettings";

vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ userId: "ann", isLoaded: true, isSignedIn: true, getToken: async () => "fixture-token" }) }));
vi.mock("@/components/help/LazyHelpLink", () => ({ LazyHelpLink: ({ slug, children }: { slug: string; children?: ReactNode }) => <a href={`/help/${slug}`}>{children ?? "Help"}</a> }));
import { DiscordSettings } from "../DiscordSettings";

const URL_A = "https://discord.com/api/webhooks/123456789012345678/secret-token-value-abcdefghijklmnop";
let hooks: DiscordHook[];
let available: boolean;
let privateEmbeds: boolean;
let requests: Array<{ path: string; method: string; body: unknown }>;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const mount = () => render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}><DiscordSettings /></SWRConfig>);
function hook(extra: Partial<DiscordHook> = {}): DiscordHook {
  return { id: "dh_1", label: "Clan chat", last4: "mnop", events: { result: true, session: true, weekly: true, milestone: true }, options: { mmr: false, replayLink: false },
    enabled: false, status: "active", disabledReason: null, failureCount: 0, previewed: false, lastPostAt: null, lastResult: null, createdAt: "2026-11-10T00:00:00.000Z", ...extra };
}
beforeEach(() => {
  hooks = []; available = true; privateEmbeds = true; requests = [];
  vi.stubGlobal("fetch", vi.fn(async (raw: string, init?: RequestInit) => {
    const path = new URL(raw, "http://localhost").pathname;
    const method = init?.method || "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    requests.push({ path, method, body });
    if (path.endsWith("/integrations/discord")) return json({ available, privateEmbeds, maxHooks: 3, hooks });
    if (path.endsWith("/hooks") && method === "POST") { hooks = [hook({ label: body.label || "Discord channel" })]; return json(hooks[0]); }
    if (path.endsWith("/preview")) { hooks = [{ ...hooks[0], previewed: true }]; return json({ previews: [{ kind: "result", example: false, payload: { embeds: [{ title: "Victory · PvZ", color: 3129201, fields: [{ name: "Opponent", value: "Zerg", inline: true }] }] } }] }); }
    if (path.endsWith("/test")) return json({ result: "webhook_gone" });
    if (method === "PATCH") { hooks = [{ ...hooks[0], ...body, events: { ...hooks[0].events, ...(body.events || {}) }, options: { ...hooks[0].options, ...(body.options || {}), mmr: body.shareMmr ?? hooks[0].options.mmr } }]; return json(hooks[0]); }
    if (method === "DELETE") { hooks = []; return json({ removed: 1 }); }
    return json({});
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("is unavailable without server storage", async () => {
  available = false; mount();
  expect(await screen.findByText(/isn't available on this server yet/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Connect channel" })).toBeNull();
});

it("keeps unsafe settings and previews off until the new server is available", async () => {
  privateEmbeds = false;
  hooks = [hook({ previewed: true, options: { mmr: true, replayLink: true } })];
  mount();
  expect(await screen.findByText(/options will be available after the server update/)).toBeTruthy();
  expect(screen.queryByRole("checkbox", { name: /Share my MMR/ })).toBeNull();
  expect(screen.getByRole("button", { name: "Preview posts" })).toBeDisabled();
  expect(screen.getByRole("switch", { name: "Post to Clan chat" })).toBeDisabled();
});

it("sends a distinct MMR opt-in and refreshes stale previews", async () => {
  hooks = [hook({ previewed: true })];
  mount();
  await act(async () => fireEvent.click(await screen.findByRole("button", { name: "Preview posts" })));
  expect(await screen.findByText("Victory · PvZ")).toBeTruthy();
  await act(async () => fireEvent.click(screen.getByRole("checkbox", { name: /Share my MMR/ })));
  expect(requests.find((row) => row.method === "PATCH")?.body).toEqual({ shareMmr: true });
  expect(screen.queryByText("Victory · PvZ")).toBeNull();
  await waitFor(() => expect(screen.getByRole("checkbox", { name: /Share my MMR/ })).toBeChecked());
});

it("connects once and forgets the URL, keeps the channel off until previewed, and shows privacy defaults", async () => {
  mount();
  const field = await screen.findByLabelText(/Webhook URL/);
  fireEvent.change(field, { target: { value: URL_A } });
  fireEvent.change(screen.getByLabelText(/Name/), { target: { value: "Clan chat" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Connect channel" })));
  await screen.findByRole("heading", { name: "Clan chat" });
  expect(requests.find((r) => r.method === "POST" && r.path.endsWith("/hooks"))?.body).toEqual({ url: URL_A, label: "Clan chat" });
  expect((screen.getByLabelText(/Webhook URL/) as HTMLInputElement).value).toBe("");
  expect(document.body.textContent).not.toContain("secret-token-value");
  expect(screen.getByText(/Webhook ending in …mnop/)).toBeTruthy();
  const toggle = screen.getByRole("switch", { name: "Post to Clan chat" }) as HTMLButtonElement;
  expect(toggle.disabled).toBe(true);
  expect(screen.queryByRole("checkbox", { name: /Show opponent names/ })).toBeNull();
  expect((screen.getByRole("checkbox", { name: /Share my MMR/ }) as HTMLInputElement).checked).toBe(false);
  expect((screen.getByRole("checkbox", { name: /Ladder milestones/ }) as HTMLInputElement).checked).toBe(false);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Preview posts" })));
  const figure = await screen.findByText("Victory · PvZ");
  expect(within(figure.closest("figure")!).getByText("Zerg")).toBeTruthy();
  await waitFor(() => expect((screen.getByRole("switch", { name: "Post to Clan chat" }) as HTMLButtonElement).disabled).toBe(false));
  await act(async () => fireEvent.click(screen.getByRole("switch", { name: "Post to Clan chat" })));
  expect(requests.find((r) => r.method === "PATCH")?.body).toEqual({ enabled: true });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Send test" })));
  expect(await screen.findByText(/no longer exists/)).toBeTruthy();
});
