import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SWRConfig } from "swr";
import type { ReactNode } from "react";
import { deviceLabel, endpointKey, vapidKeyBytes } from "@/lib/pwa/push";
import type { PushStatus } from "../PushPreferences";

vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ userId: "ann", isLoaded: true, isSignedIn: true, getToken: async () => "fixture-token" }) }));
vi.mock("@/components/help/LazyHelpLink", () => ({ LazyHelpLink: ({ slug, children }: { slug: string; children?: ReactNode }) => <a href={`/help/${slug}`}>{children ?? "Help"}</a> }));
import { PushPreferences } from "../PushPreferences";

const ENDPOINT = "https://fcm.googleapis.com/fcm/send/this-device";
let status: PushStatus;
let requests: Array<{ path: string; method: string; body: unknown }>;
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
const mount = () => render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}><PushPreferences /></SWRConfig>);

function installBrowser(permission: NotificationPermission) {
  let current: { endpoint: string; toJSON: () => unknown; unsubscribe: () => Promise<boolean> } | null = null;
  const postMessage = vi.fn();
  const pushManager = {
    getSubscription: vi.fn(async () => current),
    subscribe: vi.fn(async () => { current = { endpoint: ENDPOINT, toJSON: () => ({ endpoint: ENDPOINT, keys: { p256dh: "p", auth: "a" } }), unsubscribe: vi.fn(async () => { current = null; return true; }) }; return current; }),
  };
  const registration = { pushManager, active: { postMessage }, waiting: null, installing: null };
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { getRegistration: vi.fn(async () => registration), register: vi.fn(async () => registration) } });
  vi.stubGlobal("PushManager", function PushManager() {});
  vi.stubGlobal("Notification", Object.assign(function Notification() {}, { permission, requestPermission: vi.fn(async () => { (globalThis.Notification as unknown as { permission: string }).permission = "granted"; return "granted"; }) }));
  return { pushManager, postMessage };
}
beforeEach(() => {
  requests = [];
  status = { enabled: true, publicKey: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", groups: ["reviews", "coaching"],
    available: [{ id: "reviews", label: "Review answers" }, { id: "coaching", label: "Coaching bookings and reminders" }, { id: "other", label: "Everything else" }], devices: [] };
  vi.stubGlobal("fetch", vi.fn(async (raw: string, init?: RequestInit) => {
    const path = new URL(raw, "http://localhost").pathname; const method = init?.method || "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null; requests.push({ path, method, body });
    if (path.endsWith("/me/push") && method === "GET") return json(status);
    if (path.endsWith("/push/subscriptions")) { status = { ...status, devices: [{ id: "ps_1", label: body.label, key: await endpointKey(body.endpoint), createdAt: new Date().toISOString(), lastOkAt: null }] }; return json({ id: "ps_1" }); }
    if (path.endsWith("/push/unsubscribe")) { status = { ...status, devices: [] }; return json({ removed: 1 }); }
    if (path.endsWith("/push/preferences")) { status = { ...status, groups: body.groups }; return json({ groups: body.groups }); }
    return json({});
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); Reflect.deleteProperty(navigator, "serviceWorker"); });

it("explains push is off when the server has no keys", async () => {
  status = { ...status, enabled: false, publicKey: null }; mount();
  expect(await screen.findByText(/aren't switched on for SC2 Tools yet/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Turn on for this device" })).toBeNull();
  expect(screen.getByText(/Add to Home Screen/)).toBeTruthy();
});

it("turns this device on and off, tells the worker the API origin, and saves push choices", async () => {
  const browser = installBrowser("default");
  mount();
  await act(async () => fireEvent.click(await screen.findByRole("button", { name: "Turn on for this device" })));
  await waitFor(() => expect(screen.getByText("On for this device.", { selector: "p.text-body" })).toBeTruthy());
  expect(browser.pushManager.subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true }));
  expect(browser.postMessage).toHaveBeenCalledWith({ type: "PUSH_CONFIG", api: expect.stringMatching(/^https?:\/\/[^/]+$/) });
  expect(requests.find((r) => r.path.endsWith("/push/subscriptions"))?.body).toMatchObject({ endpoint: ENDPOINT, keys: { p256dh: "p", auth: "a" } });
  expect(await screen.findByText("This device")).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox", { name: "Everything else" }));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save push choices" })));
  expect(requests.find((r) => r.path.endsWith("/push/preferences"))?.body).toEqual({ groups: ["reviews", "coaching", "other"] });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Turn off for this device" })));
  expect(requests.find((r) => r.path.endsWith("/push/unsubscribe"))?.body).toEqual({ endpoint: ENDPOINT });
});

it("helpers label devices without the full user agent and decode VAPID keys", async () => {
  expect(deviceLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36")).toBe("Chrome on Windows");
  expect(deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1")).toBe("Safari on iOS");
  expect(vapidKeyBytes(status.publicKey!)).toHaveLength(65);
  expect(await endpointKey("x")).toMatch(/^[0-9a-f]{16}$/);
});
