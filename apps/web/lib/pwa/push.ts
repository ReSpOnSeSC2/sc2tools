/**
 * Browser side of Web Push: feature checks, the service worker
 * registration, subscribe/unsubscribe and a short device label. The API
 * stores subscriptions; nothing here is kept in local storage.
 */

export type PushSupport = "ok" | "ios-install" | "unsupported";

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

export async function pushRegistration(): Promise<ServiceWorkerRegistration> {
  const swc = container();
  if (!swc) throw new Error("Service workers are not available in this browser.");
  return (await swc.getRegistration("/")) || swc.register("/sw.js", { scope: "/" });
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

/**
 * Ask for permission and subscribe this browser. Resolves null when the
 * person declines. Also tells the service worker where the API lives so
 * it can re-register a subscription the browser rotates on its own.
 */
export async function subscribeThisDevice(publicKey: string, apiBase: string): Promise<{ subscription: PushSubscription; updateWaiting: boolean } | null> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return null;
  const reg = await pushRegistration();
  const subscription = (await reg.pushManager.getSubscription())
    ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: vapidKeyBytes(publicKey) as BufferSource });
  (reg.active || reg.waiting || reg.installing)?.postMessage({ type: "PUSH_CONFIG", api: new URL(apiBase).origin });
  return { subscription, updateWaiting: Boolean(reg.waiting) };
}
