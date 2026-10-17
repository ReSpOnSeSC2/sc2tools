"use strict";

const { randomUUID } = require("crypto");

// Kick's own web client discovers the current public transport here. Request
// Pusher explicitly: our public chatroom parser supports its wire protocol.
const DISCOVERY_URL = "https://web.kick.com/api/v1/realtime/connection";
const FETCH_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 60_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

class KickRealtimeError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "KickRealtimeError";
    this.code = "kick_realtime_unavailable";
  }
}

/**
 * Build the socket URL from tightly checked public Pusher coordinates rather
 * than accepting an arbitrary URL supplied by an upstream response.
 * @param {any} body
 * @returns {{provider: "pusher", url: string}}
 */
function parseKickConnection(body) {
  const descriptor = body?.data;
  if (descriptor?.mode !== "websocket" || !Array.isArray(descriptor.connections)) {
    throw new KickRealtimeError("Kick did not return a supported chat connection");
  }
  for (const connection of descriptor.connections) {
    if (connection?.provider !== "pusher") continue;
    const key = connection.credentials?.app_key;
    const cluster = connection.credentials?.cluster;
    if (
      typeof key !== "string" || !/^[a-zA-Z0-9]{20,64}$/.test(key)
      || typeof cluster !== "string" || !/^(?:[a-z]{2}[1-9][0-9]?|eu|mt1)$/.test(cluster)
    ) continue;
    return {
      provider: "pusher",
      url: `wss://ws-${cluster}.pusher.com/app/${key}?protocol=7&client=js&version=8.4.0-rc2&flash=false`,
    };
  }
  throw new KickRealtimeError("Kick did not return a supported chat connection");
}

/** @param {Response} response @returns {Promise<any>} */
async function readConnectionJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new KickRealtimeError("Kick returned an empty chat connection response");
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new KickRealtimeError("Kick chat connection response was too large");
    }
    chunks.push(Buffer.from(value));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

class KickRealtimeService {
  /** @param {{fetchImpl?: typeof fetch, now?: () => number}} [opts] */
  constructor(opts = {}) {
    this.fetchImpl = opts.fetchImpl || fetch;
    this.now = opts.now || Date.now;
    /** @type {{value: {provider: "pusher", url: string}, expiresAt: number} | null} */
    this.cached = null;
    /** @type {Promise<{provider: "pusher", url: string}> | null} */
    this.inFlight = null;
  }

  /** @returns {Promise<{provider: "pusher", url: string}>} */
  async getConnection() {
    if (this.cached && this.cached.expiresAt > this.now()) {
      return { ...this.cached.value };
    }
    if (this.inFlight) return { ...await this.inFlight };
    // Exactly one cache entry and one upstream promise, independent of caller
    // count or channel names. Failed lookups are never cached.
    const pending = this.discover();
    this.inFlight = pending;
    try {
      const value = await pending;
      this.cached = { value, expiresAt: this.now() + CACHE_TTL_MS };
      return { ...value };
    } finally {
      this.inFlight = null;
    }
  }

  /** @returns {Promise<{provider: "pusher", url: string}>} */
  async discover() {
    try {
      const response = await this.fetchImpl(DISCOVERY_URL, {
        method: "POST",
        redirect: "error",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "x-app-platform": "web",
          Origin: "https://kick.com",
          Referer: "https://kick.com/",
        },
        body: JSON.stringify({
          client: { id: randomUUID(), type: "web" },
          capabilities: { accepted_providers: [{ provider: "pusher" }] },
        }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new KickRealtimeError("Kick chat connection lookup failed; retrying");
      }
      return parseKickConnection(await readConnectionJson(response));
    } catch (err) {
      if (err instanceof KickRealtimeError) throw err;
      throw new KickRealtimeError("Kick chat connection lookup failed; retrying");
    }
  }
}

module.exports = {
  KickRealtimeService,
  KickRealtimeError,
  parseKickConnection,
  CACHE_TTL_MS,
  FETCH_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
};
