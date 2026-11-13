/**
 * Browser side of Web Push: feature checks, the service worker
 * registration, subscribe/unsubscribe and a short device label. The API
 * stores subscriptions; nothing here is kept in local storage.
 */

export type PushSupport = "ok" | "ios-install" | "unsupported";

const PUSH_WORKER_PROTOCOL = 1;
const HANDSHAKE_TIMEOUT_MS = 1_500;

export type PushWorkerCheck =
  | { state: "ready"; registration: ServiceWorkerRegistration; worker: ServiceWorker }
  | { state: "update" | "retry" };

/** Read navigator.serviceWorker defensively: the getter throws in sandboxed frames. */
function container(): ServiceWorkerContainer | null {
  if (typeof navigator === "undefined") return null;
  try { return navigator.serviceWorker ?? null; } catch { return null; }
}

/**
 * "ios-install": iPhone and iPad only allow push for a site added to the
 * Home Screen (iOS 16.4 and later), and only inside that installed app.
 */
export function pushSupport(): PushSupport {
  if (typeof window === "undefined") return "unsupported";
  if (container() && "PushManager" in window && "Notification" in window) return "ok";
  return /iPhone|iPad|iPod/.test(navigator.userAgent) ? "ios-install" : "unsupported";
}

function waitForActivation(worker: ServiceWorker): Promise<void> {
  return new Promise((resolve) => {
    function finish() {
      window.clearTimeout(timeout);
      worker.removeEventListener("statechange", onState);
      resolve();
    }
    function onState() {
      if (worker.state === "activated" || worker.state === "redundant") finish();
    }
    const timeout = window.setTimeout(finish, HANDSHAKE_TIMEOUT_MS);
    worker.addEventListener("statechange", onState);
    onState();
  });
}

function supportsPushProtocol(worker: ServiceWorker): Promise<boolean> {
  return new Promise((resolve) => {
    const { port1, port2 } = new MessageChannel();
    function finish(compatible: boolean) {
      window.clearTimeout(timeout);
      port1.close();
      resolve(compatible);
    }
    const timeout = window.setTimeout(() => finish(false), HANDSHAKE_TIMEOUT_MS);
    port1.onmessage = ({ data }) => finish(data?.type === "PUSH_READY" && data.version === PUSH_WORKER_PROTOCOL);
    try { worker.postMessage({ type: "PUSH_PROBE" }, [port2]); }
    catch { port2.close(); finish(false); }
  });
}

async function probeActiveWorker(registration: ServiceWorkerRegistration) {
  const candidate = registration.active ?? registration.installing;
  if (candidate && candidate.state !== "activated") await waitForActivation(candidate);
  const worker = registration.active;
  if (worker?.state !== "activated" || !await supportsPushProtocol(worker)) return null;
  const ready = { state: "ready", registration, worker } as const;
  return isReadyWorker(ready) ? ready : null;
}

/** Run before showing an enable action so the permission prompt keeps its click. */
export async function checkPushWorker(): Promise<PushWorkerCheck> {
  const swc = container();
  if (!swc) return { state: "retry" };
  try {
    const registration = (await swc.getRegistration("/")) ?? await swc.register("/sw.js", { scope: "/" });
    const ready = await probeActiveWorker(registration);
    if (ready) return ready;
    if (registration.waiting) return { state: "update" };
    void registration.update().catch(() => {});
    return { state: "retry" };
  } catch { return { state: "retry" }; }
}

/** base64url VAPID key → bytes for applicationServerKey. */
export function vapidKeyBytes(base64url: string): Uint8Array {
  const padded = base64url.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(base64url.length / 4) * 4, "=");
  const raw = atob(padded);
  return Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
}

/** First 16 hex characters of SHA-256(endpoint): the API's device key. */
export async function endpointKey(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

/** "Chrome on Windows"-style label from the user agent; never the full string. */
export function deviceLabel(userAgent: string): string {
  const browser = /Edg\//.test(userAgent) ? "Edge" : /OPR\//.test(userAgent) ? "Opera" : /Firefox\//.test(userAgent) ? "Firefox"
    : /Chrome\//.test(userAgent) ? "Chrome" : /Safari\//.test(userAgent) ? "Safari" : "Browser";
  const os = /iPhone|iPad|iPod/.test(userAgent) ? "iOS" : /Android/.test(userAgent) ? "Android" : /Windows/.test(userAgent) ? "Windows"
    : /Mac OS X/.test(userAgent) ? "macOS" : /Linux/.test(userAgent) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

/** The current subscription, only while the permission is still granted. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (pushSupport() !== "ok" || Notification.permission !== "granted") return null;
  const reg = await container()?.getRegistration("/");
  return (await reg?.pushManager.getSubscription()) ?? null;
}

/** The Push API requests permission from the click that calls subscribe. */
export async function subscribeThisDevice(
  ready: Extract<PushWorkerCheck, { state: "ready" }>,
  existing: PushSubscription | null,
  publicKey: string,
  apiBase: string,
  signal: AbortSignal,
): Promise<PushSubscription | null> {
  const { registration, worker } = ready;
  assertActiveWorker(ready, signal);
  if (existing && !hasPushKey(existing, publicKey)) {
    throw new Error("The notification key changed. Check this device again.");
  }
  let subscription;
  try {
    subscription = existing ?? await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: vapidKeyBytes(publicKey) as BufferSource,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotAllowedError") return null;
    throw error;
  }
  assertActiveWorker(ready, signal);
  worker.postMessage({ type: "PUSH_CONFIG", api: new URL(apiBase).origin });
  return subscription;
}

/** A browser subscription is bound to the public key it was created with. */
export function hasPushKey(subscription: PushSubscription, publicKey: string) {
  const saved = subscription.options.applicationServerKey;
  if (!saved) return false;
  const current = vapidKeyBytes(publicKey);
  const bytes = new Uint8Array(saved);
  return bytes.length === current.length && bytes.every((value, index) => value === current[index]);
}

export function isReadyWorker({ registration, worker }: Extract<PushWorkerCheck, { state: "ready" }>) {
  return registration.active === worker && worker.state === "activated";
}

function assertActiveWorker(ready: Extract<PushWorkerCheck, { state: "ready" }>, signal: AbortSignal) {
  signal.throwIfAborted();
  if (!isReadyWorker(ready)) {
    throw new Error("SC2 Tools updated. Check this device again before turning on notifications.");
  }
}
