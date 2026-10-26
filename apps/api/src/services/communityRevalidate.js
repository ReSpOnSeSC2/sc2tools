"use strict";

const { signGuideRevalidation, SIGNATURE_HEADER, REVALIDATE_TIMEOUT_MS } = require("./guideRevalidate");
const SCOPE = "community";

/** One active request and one coalesced pending notification per process.
 * Missing configuration is a no-op. The callback never holds up a committed
 * mutation and never logs a URL, bearer, signature or response body.
 * @param {{url?:string|null,secret?:string|null,logger?:import('pino').Logger|null,
 * fetchImpl?:typeof fetch,now?:()=>number}} [options] */
function buildCommunityRevalidator(options = {}) {
  const url = typeof options.url === "string" ? options.url.trim() : "";
  const secret = typeof options.secret === "string" ? options.secret : "";
  let supportedUrl = false;
  try { supportedUrl = ["https:", "http:"].includes(new URL(url).protocol); } catch { /* Unconfigured. */ }
  const configured = supportedUrl && secret.trim().length > 0;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const now = options.now || Date.now;
  let pending = false;
  /** @type {Promise<void>|null} */ let running = null;
  /** @param {number|undefined} status */
  function note(status) {
    try {
      if (status === undefined) options.logger?.warn("community_revalidate_failed");
      else options.logger?.warn({ status }, "community_revalidate_rejected");
    } catch { /* Logging cannot turn a committed mutation into a failure. */ }
  }

  async function send() {
    const ts = now(), body = JSON.stringify({ ts, scope: SCOPE });
    const controller = new AbortController();
    /** @type {ReturnType<typeof setTimeout>|undefined} */ let timer;
    try {
      const response = await Promise.race([fetchImpl(url, { method: "POST", headers: {
        "content-type": "application/json", [SIGNATURE_HEADER]: signGuideRevalidation(secret, ts, body),
      }, body, signal: controller.signal }), /** @type {Promise<never>} */ (new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error("revalidation_timeout")); }, REVALIDATE_TIMEOUT_MS);
      }))]);
      if (!response.ok) note(response.status);
    } catch { note(undefined); }
    finally { if (timer) clearTimeout(timer); }
  }

  function notify() {
    if (!configured) return;
    pending = true;
    if (running) return;
    running = Promise.resolve().then(async () => {
      while (pending) { pending = false; await send(); }
    }).finally(() => { running = null; if (pending) notify(); });
  }
  return { configured, notify, flush: async () => { while (running) await running; } };
}

module.exports = { SCOPE, buildCommunityRevalidator };
