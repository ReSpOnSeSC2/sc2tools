import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import Link from "next/link";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SettingsTwitchRaids } from "../SettingsTwitchRaids";

const auth = vi.hoisted(() => ({ value: { userId: "A" as string | null, isLoaded: true, getToken: vi.fn(async () => "token-A") } }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => auth.value }));
vi.mock("@/components/help/LazyHelpLink", () => ({ LazyHelpLink: ({ children }: { children: React.ReactNode }) => <Link href="/help/raid-finder">{children}</Link> }));

const ready = { serverEnabled: true, enabled: false, connected: true, permission: true, reason: null };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let fetcher: ReturnType<typeof vi.fn>;
const calls = (method: string) => fetcher.mock.calls.filter(call => (call[1]?.method ?? "GET") === method);

beforeEach(() => {
  auth.value = { userId: "A", isLoaded: true, getToken: vi.fn(async () => "token-A") };
  fetcher = vi.fn(async (_url: string, init?: RequestInit) => (init?.method === "PUT" ? json({ ...ready, enabled: JSON.parse(String(init.body)).enabled }) : json(ready)));
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("starts off, and the switch saves at once with the saved answer shown", async () => {
  render(<SettingsTwitchRaids />);
  const toggle = await screen.findByRole("switch", { name: /Allow raids from the Stream Dock/ });
  await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(false));
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(toggle);
  await screen.findByText(/Raids are on/);
  expect(JSON.parse(String(calls("PUT")[0][1]?.body))).toEqual({ enabled: true });
  expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
  expect(calls("PUT")[0][1]?.headers).toMatchObject({ authorization: "Bearer token-A" });
});

it("cannot be switched on before raids are allowed, and says what to do", async () => {
  fetcher.mockResolvedValue(json({ ...ready, permission: false, reason: "raid_permission_required" }));
  render(<SettingsTwitchRaids />);
  await screen.findByText(/raids have not been allowed/);
  expect(screen.getByRole("switch").hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("button", { name: "Connect raids" })).toBeTruthy();
});

it("a server that has not turned raids on disables connecting", async () => {
  fetcher.mockResolvedValue(json({ ...ready, serverEnabled: false, permission: false, reason: "server_not_enabled" }));
  render(<SettingsTwitchRaids />);
  await screen.findByText(/paused by the server owner/);
  expect(screen.getByRole("button", { name: "Connect raids" }).hasAttribute("disabled")).toBe(true);
});

it("Connect raids asks the server for the raids purpose and opens only Twitch's own page", async () => {
  const popup = { location: { replace: vi.fn() }, close: vi.fn() };
  vi.stubGlobal("open", vi.fn(() => popup));
  fetcher.mockImplementation(async (_url: string, init?: RequestInit) => (init?.method === "POST" ? json({ authorizeUrl: "https://id.twitch.tv/oauth2/authorize?scope=channel%3Amanage%3Araids" }) : json(ready)));
  render(<SettingsTwitchRaids />);
  const connect = await screen.findByRole("button", { name: "Reconnect raids" });
  await waitFor(() => expect(connect.hasAttribute("disabled")).toBe(false));
  fireEvent.click(connect);
  await waitFor(() => expect(popup.location.replace).toHaveBeenCalledWith(expect.stringContaining("https://id.twitch.tv/oauth2/authorize")));
  expect(JSON.parse(String(calls("POST")[0][1]?.body))).toEqual({ purpose: "raids" });
});

it("a different host in the connect address is refused and the window closed", async () => {
  const popup = { location: { replace: vi.fn() }, close: vi.fn() };
  vi.stubGlobal("open", vi.fn(() => popup));
  fetcher.mockImplementation(async (_url: string, init?: RequestInit) => (init?.method === "POST" ? json({ authorizeUrl: "https://evil.example/oauth2/authorize" }) : json(ready)));
  render(<SettingsTwitchRaids />);
  const connect = await screen.findByRole("button", { name: "Reconnect raids" });
  await waitFor(() => expect(connect.hasAttribute("disabled")).toBe(false));
  fireEvent.click(connect);
  expect((await screen.findByRole("alert")).textContent).toContain("invalid");
  expect(popup.location.replace).not.toHaveBeenCalled();
  expect(popup.close).toHaveBeenCalled();
});

it("a signed-out visitor is asked to sign in and nothing is requested", () => {
  auth.value = { userId: null, isLoaded: true, getToken: vi.fn(async () => "x") };
  render(<SettingsTwitchRaids />);
  expect(screen.getByText("Sign in to manage raids.")).toBeTruthy();
  expect(fetcher).not.toHaveBeenCalled();
});
