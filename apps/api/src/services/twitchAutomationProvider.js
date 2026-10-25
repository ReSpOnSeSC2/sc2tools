"use strict";

const { plain } = require("./twitchAutomationPolicy");
const MAX_BYTES = 32 * 1024;
const STATES = ["ACTIVE", "LOCKED", "RESOLVED", "CANCELED"];
/** @typedef {{accessToken:string,platformUserId:string,boundedFetch:typeof fetch,assertCurrent:()=>Promise<void>}} Grant */
/** @param {unknown} value @returns {value is string} */
const id = value => typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);

class TwitchAutomationProviderError extends Error {
  /** @param {string} code @param {number} status @param {boolean} uncertain @param {Record<string,string>} [receipt] */
  constructor(code, status, uncertain, receipt = {}) {
    super(status === 401 || status === 403 ? "Reconnect Twitch automation permissions."
      : status === 429 ? "Twitch rate limited this operation. Check status before retrying."
        : uncertain ? "Twitch did not confirm the operation. Check its status before retrying."
          : "Twitch could not complete this operation.");
    this.code = code; this.status = status; this.uncertain = uncertain; this.receipt = receipt;
  }
}
/** @param {unknown} value */
function one(value) {
  const body = /** @type {any} */ (value);
  return Array.isArray(body?.data) && body.data.length === 1 ? body.data[0] : null;
}
/** Only exact outcome labels/IDs become trusted resolve inputs. @param {any} row */
function outcomes(row) {
  const choices = Array.isArray(row?.outcomes) && row.outcomes.length === 2 ? row.outcomes : [];
  const win = choices.find((/** @type {any} */ value) => value?.title === "Win" && id(value.id));
  const loss = choices.find((/** @type {any} */ value) => value?.title === "Loss" && id(value.id));
  return { winId: win?.id && win.id !== loss?.id ? String(win.id) : null, lossId: loss?.id && loss.id !== win?.id ? String(loss.id) : null };
}

/** Bounded Helix transport. It never logs provider text or returns credentials,
 * full provider bodies, viewer identities or channel-point balances. */
class TwitchAutomationProvider {
  /** @param {{clientId:string,timeoutMs?:number}} deps */
  constructor({ clientId, timeoutMs = 12_000 }) { this.clientId = clientId; this.timeoutMs = timeoutMs; }

  /** @param {Grant} grant @param {string} path @param {'GET'|'POST'|'PATCH'} method @param {object} [body] */
  async request(grant, path, method, body) {
    const controller = new AbortController(); let dispatched = false;
    /** @type {{reader:ReadableStreamDefaultReader<Uint8Array>|null}} */ const stream = { reader: null };
    /** @type {ReturnType<typeof setTimeout>|undefined} */ let timer;
    const write = method !== "GET";
    try {
      return await Promise.race([
        (async () => {
          await grant.assertCurrent(); controller.signal.throwIfAborted(); dispatched = true;
          const response = await grant.boundedFetch(`https://api.twitch.tv/helix/${path}`, { method, redirect: "error", signal: controller.signal,
            headers: { Authorization: `Bearer ${grant.accessToken}`, "Client-Id": this.clientId, ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
          if (!response.ok || response.status !== 200) {
            void response.body?.cancel().catch(() => {});
            throw new TwitchAutomationProviderError("twitch_automation_rejected", response.status, write && (response.status >= 500 || response.ok));
          }
          if (Number(response.headers.get("content-length") || 0) > MAX_BYTES || !response.body) throw new TwitchAutomationProviderError("twitch_automation_response_invalid", 502, write);
          const reader = response.body.getReader(); stream.reader = reader; const chunks = []; let bytes = 0;
          while (true) {
            const chunk = await reader.read(); controller.signal.throwIfAborted();
            if (chunk.done) break; bytes += chunk.value.byteLength;
            if (bytes > MAX_BYTES) throw new TwitchAutomationProviderError("twitch_automation_response_too_large", 502, write);
            chunks.push(Buffer.from(chunk.value));
          }
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); await grant.assertCurrent(); controller.signal.throwIfAborted(); return parsed;
        })(),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new TwitchAutomationProviderError("twitch_automation_timeout", 504, write && dispatched)); }, this.timeoutMs); }),
      ]);
    } catch (error) {
      if (error instanceof TwitchAutomationProviderError) throw error;
      throw new TwitchAutomationProviderError("twitch_automation_unconfirmed", 502, write && dispatched);
    } finally {
      clearTimeout(timer); controller.abort();
      if (stream.reader) void stream.reader.cancel().catch(() => {});
    }
  }

  /** @param {Grant} grant */
  async broadcaster(grant) {
    const row = one(await this.request(grant, `users?id=${encodeURIComponent(grant.platformUserId)}`, "GET"));
    if (!row || row.id !== grant.platformUserId) throw new TwitchAutomationProviderError("twitch_broadcaster_unverified", 502, false);
    return { eligible: ["affiliate", "partner"].includes(row.broadcaster_type), name: plain(row.display_name || row.login).slice(0, 80) };
  }
  /** @param {Grant} grant */
  async isLive(grant) {
    const body = await this.request(grant, `streams?user_id=${encodeURIComponent(grant.platformUserId)}`, "GET");
    if (!Array.isArray(body?.data) || body.data.length > 1) throw new TwitchAutomationProviderError("twitch_stream_unverified", 502, false);
    if (!body.data.length) return false;
    if (body.data[0].user_id !== grant.platformUserId) throw new TwitchAutomationProviderError("twitch_stream_unverified", 502, false);
    return body.data[0].type === "live";
  }
  /** @param {Grant} grant @param {string} title @param {number} windowSec */
  async createPrediction(grant, title, windowSec) {
    if (!title || Array.from(title).length > 45 || plain(title) !== title || !Number.isInteger(windowSec) || windowSec < 30 || windowSec > 300) throw new TwitchAutomationProviderError("twitch_prediction_input_invalid", 400, false);
    const row = one(await this.request(grant, "predictions", "POST", { broadcaster_id: grant.platformUserId, title, outcomes: [{ title: "Win" }, { title: "Loss" }], prediction_window: windowSec }));
    const owned = row?.broadcaster_id === grant.platformUserId && id(row?.id);
    const choices = outcomes(row);
    if (!owned || !choices.winId || !choices.lossId || row.status !== "ACTIVE" || row.title !== title || row.prediction_window !== windowSec) {
      throw new TwitchAutomationProviderError("twitch_prediction_receipt_incomplete", 502, true, owned ? { predictionId: row.id } : {});
    }
    return { predictionId: String(row.id), winId: choices.winId, lossId: choices.lossId };
  }
  /** @param {Grant} grant @param {string} predictionId */
  async prediction(grant, predictionId) {
    if (!id(predictionId)) throw new TwitchAutomationProviderError("twitch_prediction_id_invalid", 400, false);
    const row = one(await this.request(grant, `predictions?broadcaster_id=${encodeURIComponent(grant.platformUserId)}&id=${encodeURIComponent(predictionId)}`, "GET"));
    if (!row || row.id !== predictionId || row.broadcaster_id !== grant.platformUserId || !STATES.includes(row.status)) throw new TwitchAutomationProviderError("twitch_prediction_unverified", 502, false);
    return { predictionId, status: String(row.status), ...outcomes(row), winningId: id(row.winning_outcome_id) ? row.winning_outcome_id : null };
  }
  /** @param {Grant} grant @param {string} predictionId @param {'RESOLVED'|'CANCELED'} status @param {string} [winningId] */
  async endPrediction(grant, predictionId, status, winningId) {
    if (!id(predictionId) || !["RESOLVED", "CANCELED"].includes(status) || status === "RESOLVED" && !id(winningId)) throw new TwitchAutomationProviderError("twitch_prediction_end_invalid", 400, false);
    const row = one(await this.request(grant, "predictions", "PATCH", { broadcaster_id: grant.platformUserId, id: predictionId, status, ...(status === "RESOLVED" ? { winning_outcome_id: winningId } : {}) }));
    if (!row || row.id !== predictionId || row.broadcaster_id !== grant.platformUserId || row.status !== status || status === "RESOLVED" && row.winning_outcome_id !== winningId) throw new TwitchAutomationProviderError("twitch_prediction_end_unconfirmed", 502, true);
    return { status };
  }
  /** @param {Grant} grant @param {string} description */
  async createMarker(grant, description) {
    if (!description || Array.from(description).length > 140 || plain(description) !== description) throw new TwitchAutomationProviderError("twitch_marker_input_invalid", 400, false);
    const row = one(await this.request(grant, "streams/markers", "POST", { user_id: grant.platformUserId, description }));
    if (!row || !id(row.id) || !Number.isInteger(row.position_seconds) || row.position_seconds < 0 || row.description !== description) throw new TwitchAutomationProviderError("twitch_marker_receipt_incomplete", 502, true);
    return { markerId: String(row.id), positionSeconds: Number(row.position_seconds) };
  }
}

module.exports = { TwitchAutomationProvider, TwitchAutomationProviderError, MAX_BYTES };
