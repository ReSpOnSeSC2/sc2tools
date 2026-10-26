/** Public reachability only: no account credentials or database health probe. */
export const STATUS_CHECK_TIMEOUT_MS = 4_000;
export type Reachability = "unknown" | "checking" | "reachable" | "unavailable";
export type CheckResult = { state: Reachability; message: string; checkedAt: string | null };
export const INITIAL_CHECK: CheckResult = { state: "unknown", message: "Waiting to check from this browser.", checkedAt: null };
export const CHECKING: CheckResult = { state: "checking", message: "Waiting for a response…", checkedAt: null };

function isLocalHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/\.$/, "");
  return normalized === "localhost" || normalized.endsWith(".localhost")
    || ["[::1]", "[::]", "0.0.0.0"].includes(normalized)
    || /^127(?:\.\d{1,3}){3}$/.test(normalized)
    || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(normalized);
}

/** The deployment's existing public API base, never a visitor-supplied URL.
 * Missing production config must not probe the visitor's local computer. */
export function publicApiPingUrl(base: string | undefined, websiteOrigin: string): string | null {
  try {
    const localPage = isLocalHost(new URL(websiteOrigin).hostname);
    const configured = base?.trim() || (localPage ? "http://localhost:8080" : "");
    const api = new URL(configured);
    if (api.username || api.password || api.search || api.hash) return null;
    const localApi = isLocalHost(api.hostname);
    if ((!localPage && localApi) || (api.protocol !== "https:" && !(localPage && localApi && api.protocol === "http:"))) return null;
    api.pathname = `${api.pathname.replace(/\/+$/, "")}/v1/ping`;
    return api.toString();
  } catch { return null; }
}

const retired = () => new DOMException("The status check was cancelled.", "AbortError");
const completed = (state: Reachability, message: string): CheckResult => ({ state, message, checkedAt: new Date().toISOString() });
const UNEXPECTED_RESPONSE = "The service returned an unexpected response, so reachability couldn't be verified.";

/** A deadline includes the response body and settles adapters ignoring abort. */
export async function checkPublicReachability(url: string | null, callerSignal: AbortSignal): Promise<CheckResult> {
  if (callerSignal.aborted) throw retired();
  if (!url) return completed("unknown", "The API check isn't available from this page.");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel = () => {};
  let timedOut = false;
  const stopped = new Promise<never>((_resolve, reject) => {
    cancel = () => { controller.abort(); reject(retired()); };
    callerSignal.addEventListener("abort", cancel, { once: true });
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error("status_check_timeout"));
    }, STATUS_CHECK_TIMEOUT_MS);
  });
  try {
    const result = await Promise.race([readPing(url, controller.signal), stopped]);
    if (callerSignal.aborted) throw retired();
    return result;
  } catch {
    if (callerSignal.aborted) throw retired();
    return completed("unknown", timedOut ? "No response within 4 seconds. Try refreshing the checks."
      : "This browser couldn't verify the service. Your connection or browser access rules may affect this check.");
  } finally {
    clearTimeout(timer);
    callerSignal.removeEventListener("abort", cancel);
    controller.abort();
  }
}

async function readPing(url: string, signal: AbortSignal): Promise<CheckResult> {
  const response = await fetch(url, {
    method: "GET", credentials: "omit", cache: "no-store", redirect: "error",
    referrerPolicy: "no-referrer", headers: { accept: "application/json" }, signal,
  });
  if (!response.ok) return completed("unavailable", `The service responded with HTTP ${response.status}. Try again shortly.`);
  let body: unknown;
  try { body = await response.json(); }
  catch (error) {
    if (signal.aborted) throw error;
    return completed("unknown", UNEXPECTED_RESPONSE);
  }
  if (!body || typeof body !== "object" || !("status" in body) || body.status !== "ok") {
    return completed("unknown", UNEXPECTED_RESPONSE);
  }
  return completed("reachable", "The public endpoint responded successfully.");
}
