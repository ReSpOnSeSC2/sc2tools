import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SWRConfig } from "swr";
import type { ReactNode } from "react";
import { deviceLabel, endpointKey, vapidKeyBytes } from "@/lib/pwa/push";
import type { PushStatus } from "../PushPreferences";

const auth = vi.hoisted(() => ({ userId: "ann", hold: false, release: null as (() => void) | null }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({
  userId: auth.userId, isLoaded: true, isSignedIn: true,
  getToken: async () => {
    if (auth.hold) await new Promise<void>((resolve) => { auth.release = resolve; });
    return `fixture-${auth.userId}`;
  },
}) }));
vi.mock("@/components/help/LazyHelpLink", () => ({ LazyHelpLink: ({ slug, children }: { slug: string; children?: ReactNode }) => <a href={`/help/${slug}`}>{children ?? "Help"}</a> }));
import { PushPreferences } from "../PushPreferences";
import { SettingsSaveScope } from "@/components/analyzer/settings/SettingsSaveBar";

const ENDPOINT = "https://fcm.googleapis.com/fcm/send/this-device";
let status: PushStatus;
let requests: Array<{ path: string; method: string; body: unknown; owner: string | null }>;
let rejectRegistration: boolean;
let deviceOwnedByAnotherAccount: boolean;
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
const panel = () => <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}><SettingsSaveScope tabId="preferences"><PushPreferences /></SettingsSaveScope></SWRConfig>;
const mount = () => render(panel());

function installBrowser(permission: NotificationPermission, options: { existing?: boolean; wrongKey?: boolean; version?: number } = {}) {
  const unsubscribe = vi.fn(async () => { current = null; return true; });
  let current: ReturnType<typeof subscription> | null = options.existing ? subscription(options.wrongKey) : null;
  function subscription(wrongKey = false) {
    return { endpoint: ENDPOINT, options: { applicationServerKey: wrongKey ? new ArrayBuffer(65) : vapidKeyBytes(status.publicKey!).buffer },
      toJSON: () => ({ endpoint: ENDPOINT, keys: { p256dh: "p", auth: "a" } }),
      unsubscribe };
  }
  let version = options.version ?? 1;
  type ReplyPort = { onmessage: ((event: { data: unknown }) => void) | null; close: () => void };
  class LocalChannel {
    port1: ReplyPort = { onmessage: null, close: vi.fn() };
    port2 = { close: vi.fn(), postMessage: (data: unknown) => { this.port1.onmessage?.({ data }); } };
  }
  vi.stubGlobal("MessageChannel", LocalChannel);
  const postMessage = vi.fn((message: { type: string }, ports?: LocalChannel["port2"][]) => {
    if (message.type === "PUSH_PROBE") ports?.[0].postMessage({ type: "PUSH_READY", version });
  });
  const notice = Object.assign(function Notification() {}, { permission, requestPermission: vi.fn() });
  const pushManager = {
    getSubscription: vi.fn(async () => current),
    subscribe: vi.fn(async () => { notice.permission = "granted"; current = subscription(); return current; }),
  };
  const active = { postMessage, state: "activated" };
  const registration = { pushManager, active, waiting: null, installing: null, update: vi.fn(async () => {}) };
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { getRegistration: vi.fn(async () => registration), register: vi.fn(async () => registration) } });
  vi.stubGlobal("PushManager", function PushManager() {});
  vi.stubGlobal("Notification", notice);
  return { pushManager, postMessage, registration, notice, unsubscribe, setVersion: (value: number) => { version = value; } };
}
async function registerDevice(body: { label: string; endpoint: string }) {
  if (rejectRegistration) {
    rejectRegistration = false;
    return Response.json({ error: { code: "temporary_failure", message: "The server could not register this device." } }, { status: 503 });
  }
  status = { ...status, devices: [{ id: "ps_1", label: body.label, key: await endpointKey(body.endpoint), createdAt: new Date().toISOString(), lastOkAt: null }] };
  return json({ id: "ps_1" });
}

function deactivateDevice() {
  const removed = status.devices.length;
  status = { ...status, devices: [] };
  return json({ removed: deviceOwnedByAnotherAccount ? 0 : removed, canDeactivate: !deviceOwnedByAnotherAccount });
}

beforeEach(() => {
  requests = [];
  rejectRegistration = false;
  deviceOwnedByAnotherAccount = false;
  auth.userId = "ann";
  auth.hold = false;
  auth.release = null;
  status = { enabled: true, publicKey: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", groups: ["reviews", "coaching"],
    available: [{ id: "reviews", label: "Review answers" }, { id: "coaching", label: "Coaching bookings and reminders" }, { id: "other", label: "Everything else" }], devices: [] };
  vi.stubGlobal("fetch", vi.fn(async (raw: string, init?: RequestInit) => {
    const path = new URL(raw, "http://localhost").pathname; const method = init?.method || "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const owner = new Headers(init?.headers).get("authorization");
    requests.push({ path, method, body, owner });
    if (path === "/v1/me/push") return json(status);
    if (path === "/v1/me/push/subscriptions") return registerDevice(body);
    if (path === "/v1/me/push/unsubscribe") return deactivateDevice();
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
  fireEvent.click(await screen.findByRole("button", { name: "Turn on for this device" }));
  await waitFor(() => expect(screen.getByText("On for this device.", { selector: "p.text-body" })).toBeTruthy());
  expect(browser.pushManager.subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true }));
  expect(browser.postMessage).toHaveBeenCalledWith({ type: "PUSH_CONFIG", api: expect.stringMatching(/^https?:\/\/[^/]+$/) });
  expect(browser.postMessage).toHaveBeenCalledWith({ type: "PUSH_PROBE" }, expect.any(Array));
  expect(browser.postMessage.mock.invocationCallOrder[0]).toBeLessThan(browser.pushManager.subscribe.mock.invocationCallOrder[0]);
  expect(requests.find((r) => r.path.endsWith("/push/subscriptions"))?.body).toMatchObject({ endpoint: ENDPOINT, keys: { p256dh: "p", auth: "a" }, enrollmentVersion: 1 });
  expect(await screen.findByText("This device")).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox", { name: "Everything else" }));
  fireEvent.click(screen.getByRole("button", { name: "Save push choices" }));
  await waitFor(() => expect(requests.find((r) => r.path.endsWith("/push/preferences"))?.body).toEqual({ groups: ["reviews", "coaching", "other"] }));
  fireEvent.click(screen.getByRole("button", { name: "Turn off for this device" }));
  await waitFor(() => expect(requests).toContainEqual({ path: "/v1/me/push/unsubscribe", method: "POST", body: { endpoint: ENDPOINT, enrollmentVersion: 1 }, owner: "Bearer fixture-ann" }));
  expect(await screen.findByRole("button", { name: "Turn on for this device" })).toBeTruthy();
  expect(browser.notice.requestPermission).not.toHaveBeenCalled();
  expect(browser.unsubscribe).toHaveBeenCalledTimes(1);
});

it("leaves the browser subscription alone when a stale device row has transferred", async () => {
  const browser = installBrowser("granted", { existing: true });
  status = { ...status, devices: [{ id: "ps_1", key: await endpointKey(ENDPOINT), label: "Browser",
    createdAt: new Date().toISOString(), lastOkAt: null }] };
  mount();
  deviceOwnedByAnotherAccount = true;
  fireEvent.click(await screen.findByRole("button", { name: "Turn off for this device" }));
  await screen.findByText(/This device registration changed/);
  expect(browser.unsubscribe).not.toHaveBeenCalled();
});

it("retries local deactivation after the server row has already been removed", async () => {
  const browser = installBrowser("granted", { existing: true });
  status = { ...status, devices: [{ id: "ps_1", key: await endpointKey(ENDPOINT), label: "Browser",
    createdAt: new Date().toISOString(), lastOkAt: null }] };
  browser.unsubscribe.mockRejectedValueOnce(new Error("Browser unavailable"));
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Turn off for this device" }));
  fireEvent.click(await screen.findByRole("button", { name: "Retry turning off this device" }));
  expect(await screen.findByText("Notifications are off for this device.")).toBeTruthy();
  expect(browser.unsubscribe).toHaveBeenCalledTimes(2);
});

it("does not subscribe on an older active worker and retries after the worker is updated", async () => {
  const browser = installBrowser("default", { version: 0 });
  mount();
  expect(await screen.findByText(/This device could not be checked/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Turn on for this device" })).toBeNull();
  expect(browser.pushManager.subscribe).not.toHaveBeenCalled();
  expect(browser.registration.update).toHaveBeenCalled();
  browser.setVersion(1);
  fireEvent.click(screen.getByRole("button", { name: "Check this device again" }));
  expect(await screen.findByRole("button", { name: "Turn on for this device" })).toBeTruthy();
  expect(browser.pushManager.subscribe).not.toHaveBeenCalled();
});

it("switching accounts with granted permission does not silently transfer this browser", async () => {
  const browser = installBrowser("granted", { existing: true });
  status = { ...status, devices: [{ id: "ps_ann", key: await endpointKey(ENDPOINT), label: "Old owner browser",
    createdAt: new Date().toISOString(), lastOkAt: null }] };
  const view = mount();
  expect(await screen.findByRole("button", { name: "Turn off for this device" })).toBeTruthy();
  await act(async () => { auth.userId = "bob"; status = { ...status, devices: [] }; view.rerender(panel()); });
  const action = await screen.findByRole("button", { name: "Turn on for this device" });
  expect(requests.filter((r) => r.method === "POST")).toEqual([]);
  expect(browser.pushManager.subscribe).not.toHaveBeenCalled();
  fireEvent.click(action);
  expect(await screen.findByRole("button", { name: "Turn off for this device" })).toBeTruthy();
  expect(requests.filter((r) => r.method === "POST")).toEqual([
    expect.objectContaining({ owner: "Bearer fixture-bob", path: "/v1/me/push/subscriptions" }),
  ]);
  expect(browser.pushManager.subscribe).not.toHaveBeenCalled();
});

it("drops a held registration when the owner changes before the token returns", async () => {
  installBrowser("granted", { existing: true });
  const view = mount();
  const action = await screen.findByRole("button", { name: "Turn on for this device" });
  auth.hold = true;
  fireEvent.click(action);
  await waitFor(() => expect(auth.release).toBeTypeOf("function"));
  await act(async () => {
    auth.hold = false;
    auth.userId = "bob";
    view.rerender(panel());
  });
  await act(async () => { auth.release?.(); });
  expect(await screen.findByRole("button", { name: "Turn on for this device" })).toBeTruthy();
  expect(requests.filter((r) => r.method === "POST")).toEqual([]);
});

it("asks the owner to reset a mismatched VAPID key before a new subscribe click", async () => {
  const browser = installBrowser("granted", { existing: true, wrongKey: true });
  mount();
  const reset = await screen.findByRole("button", { name: "Reset notifications on this device" });
  expect(browser.pushManager.subscribe).not.toHaveBeenCalled();
  expect(requests.filter((r) => r.method === "POST")).toEqual([]);
  fireEvent.click(reset);
  expect(await screen.findByRole("button", { name: "Turn on for this device" })).toBeTruthy();
  expect(browser.pushManager.subscribe).not.toHaveBeenCalled();
  expect(requests.filter((r) => r.method === "POST")).toEqual([]);
});

it("leaves a denied browser unsubscribed on the server", async () => {
  const browser = installBrowser("default");
  browser.pushManager.subscribe.mockImplementationOnce(async () => {
    browser.notice.permission = "denied";
    throw new DOMException("Denied", "NotAllowedError");
  });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Turn on for this device" }));
  expect(await screen.findByText(/This browser blocks notifications/)).toBeTruthy();
  expect(requests.filter((r) => r.method === "POST")).toEqual([]);
});

it("reuses the local subscription after a failed server registration", async () => {
  const browser = installBrowser("default");
  rejectRegistration = true;
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Turn on for this device" }));
  expect(await screen.findByText(/Something went wrong on our side/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Turn on for this device" }));
  expect(await screen.findByRole("button", { name: "Turn off for this device" })).toBeTruthy();
  expect(browser.pushManager.subscribe).toHaveBeenCalledTimes(1);
  expect(requests.filter((r) => r.method === "POST")).toHaveLength(2);
});

it("helpers label devices without the full user agent and decode VAPID keys", async () => {
  expect(deviceLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36")).toBe("Chrome on Windows");
  expect(deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1")).toBe("Safari on iOS");
  expect(vapidKeyBytes(status.publicKey!)).toHaveLength(65);
  expect(await endpointKey("x")).toMatch(/^[0-9a-f]{16}$/);
});
