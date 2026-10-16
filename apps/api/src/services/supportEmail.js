"use strict";

const crypto = require("crypto");
const { EVENT_TYPES, MESSAGE_BODY_MAX } = require("./adminEvents");

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const OVERLAP_SEC = 5 * 60;
const MAX_PAGES_PER_RUN = 5;
const REQUEST_TIMEOUT_MS = 15000;

/**
 * @typedef {{
 *   mailbox: string, clientId: string, clientSecret: string,
 *   refreshToken: string, startAfter: string, intervalMs: number,
 * }} SupportEmailConfig
 */

/** Read-only Gmail -> the existing admin Messages feed. No send/modify APIs. */
class SupportEmailService {
  /**
   * @param {{
   *   db: import('../db/connect').DbContext,
   *   adminEvents: import('./adminEvents').AdminEventsService,
   *   config: SupportEmailConfig,
   *   fetchImpl?: typeof fetch,
   *   now?: () => number,
   * }} deps
   */
  constructor(deps) {
    this.db = deps.db;
    this.adminEvents = deps.adminEvents;
    this.config = deps.config;
    this.fetchImpl = deps.fetchImpl || globalThis.fetch;
    this.now = deps.now || Date.now;
    this.stateId = crypto.createHash("sha256").update(deps.config.mailbox).digest("hex");
  }

  /**
   * Per-page checkpoints survive restarts and failures. A compare-and-swap
   * revision lets multiple API instances safely replay work without moving
   * another instance's checkpoint backwards. The event unique key is the
   * final duplicate guard, including a crash between insert and checkpoint.
   */
  async sync() {
    const initialAfter = Math.floor(Date.parse(this.config.startAfter) / 1000);
    await this.db.supportEmailSync.updateOne(
      { _id: this.stateId },
      {
        $setOnInsert: { afterSec: initialAfter, revision: 0 },
        $set: { lastAttemptAt: new Date(this.now()) },
      },
      { upsert: true },
    );
    const token = await this.accessToken();
    const profile = await this.getJson(`${GMAIL_BASE}/profile`, token);
    if (profile.emailAddress?.toLowerCase() !== this.config.mailbox) {
      throw syncError("mailbox_mismatch");
    }
    let state = await this.db.supportEmailSync.findOne({ _id: this.stateId });
    let processed = 0;
    for (let page = 0; page < MAX_PAGES_PER_RUN; page += 1) {
      const endSec = state.windowEndSec || Math.floor(this.now() / 1000);
      if (endSec <= state.afterSec) break;
      const params = new URLSearchParams({
        q: `after:${state.afterSec - 1} before:${endSec} -in:sent -in:drafts -in:chats`,
        maxResults: "50",
        includeSpamTrash: "false",
      });
      if (state.pageToken) params.set("pageToken", state.pageToken);
      let result;
      try {
        result = await this.getJson(`${GMAIL_BASE}/messages?${params}`, token);
      } catch (err) {
        // Gmail may invalidate pagination tokens. Rewind this SAME window;
        // persisted event keys make the replay safe, with no skipped page.
        if (state.pageToken && /** @type {any} */ (err).code === "gmail_http_400") {
          await this.checkpoint(state, { pageToken: null });
        }
        throw err;
      }
      for (const row of result.messages || []) {
        await this.importMessage(row.id, token);
        processed += 1;
      }
      const next = result.nextPageToken
        ? { pageToken: result.nextPageToken, windowEndSec: endSec }
        : {
          afterSec: Math.max(initialAfter, endSec - OVERLAP_SEC),
          pageToken: null,
          windowEndSec: null,
          lastSuccessAt: new Date(this.now()),
          lastErrorCode: null,
        };
      if (!await this.checkpoint(state, next)) break;
      if (!result.nextPageToken) break;
      state = { ...state, ...next, revision: state.revision + 1 };
    }
    return { processed };
  }

  /** @param {string} code */
  async reportFailure(code) {
    await this.db.supportEmailSync.updateOne(
      { _id: this.stateId },
      { $set: { lastErrorCode: code, lastAttemptAt: new Date(this.now()) } },
    );
  }

  /** @param {any} state @param {Record<string, unknown>} next */
  async checkpoint(state, next) {
    const result = await this.db.supportEmailSync.updateOne(
      { _id: this.stateId, revision: state.revision },
      { $set: next, $inc: { revision: 1 } },
    );
    return result.modifiedCount === 1;
  }

  /** @param {string} id @param {string} token */
  async importMessage(id, token) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw syncError("invalid_message_id");
    const ingestionKey = `gmail:${this.stateId}:${id}`;
    // Avoid downloading/rebroadcasting already imported mail every overlap.
    if (await this.db.adminEvents.findOne({ ingestionKey }, { projection: { _id: 1 } })) return;
    let mail;
    try {
      mail = await this.getJson(`${GMAIL_BASE}/messages/${id}?format=full`, token);
    } catch (err) {
      // Mail deleted between list and get no longer belongs in this inbox.
      if (/** @type {any} */ (err).code === "gmail_http_404") return;
      throw err;
    }
    if ((mail.labelIds || []).some((/** @type {string} */ label) =>
      ["SENT", "DRAFT", "SPAM", "TRASH", "CHAT"].includes(label))) return;
    const receivedAt = Number(mail.internalDate);
    if (!Number.isFinite(receivedAt)) throw syncError("invalid_message_date");
    if (receivedAt < Date.parse(this.config.startAfter)) return;
    const payload = messagePayload(mail, this.config.mailbox);
    const doc = await this.adminEvents.record(EVENT_TYPES.USER_MESSAGE, payload, { ingestionKey });
    // record() is best-effort for analytics; an inbox delivery must retry.
    if (!doc) throw syncError("message_not_saved");
  }

  async accessToken() {
    const response = await this.fetchImpl("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        refresh_token: this.config.refreshToken,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw syncError(`oauth_http_${response.status}`);
    const result = await response.json();
    if (typeof result.access_token !== "string" || !result.access_token) {
      throw syncError("oauth_missing_access_token");
    }
    return result.access_token;
  }

  /** @param {string} url @param {string} token @returns {Promise<any>} */
  async getJson(url, token) {
    const response = await this.fetchImpl(url, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw syncError(`gmail_http_${response.status}`);
    return response.json();
  }
}

/** @param {any} mail @param {string} mailbox */
function messagePayload(mail, mailbox) {
  const headers = mail.payload?.headers || [];
  /** @param {string} name */
  const header = (name) => headers.find((/** @type {any} */ h) =>
    h.name?.toLowerCase() === name)?.value || "";
  const from = header("from").replace(/[\r\n]/g, " ").trim();
  const address = from.match(/<([^<>]+@[^<>]+)>/)?.[1] || from;
  const { text, attachments } = readableBody(mail.payload);
  const attachmentNote = attachments.length ? `\n\nAttachments: ${attachments.join(", ")}` : "";
  const body = `${text || mail.snippet || "[Open the original email to read this message.]"}${attachmentNote}`;
  const shortened = "\n\n[Message shortened; open the original email for the full text.]";
  return {
    userId: null,
    clerkUserId: null,
    email: address,
    subject: header("subject").trim() || "(No subject)",
    message: body.length > MESSAGE_BODY_MAX
      ? `${body.slice(0, MESSAGE_BODY_MAX - shortened.length)}${shortened}` : body,
    source: "email",
    mailbox,
    gmailMessageId: mail.id,
    receivedAt: new Date(Number(mail.internalDate)).toISOString(),
  };
}

/** Decode text parts only. Attachments remain in Gmail, accessible via link. @param {any} payload */
function readableBody(payload) {
  /** @type {string[]} */
  const plain = [];
  /** @type {string[]} */
  const html = [];
  /** @type {string[]} */
  const attachments = [];
  let visited = 0;
  let remaining = 200000;
  /** @param {any} part @param {number} depth */
  function visit(part, depth) {
    if (!part || depth > 16 || visited++ > 100) return;
    if (part.filename) {
      if (attachments.length < 20) attachments.push(String(part.filename).slice(0, 150));
      return;
    }
    if (remaining > 0 && part.body?.data && ["text/plain", "text/html"].includes(part.mimeType)) {
      const encoded = String(part.body.data).slice(0, remaining);
      remaining -= encoded.length;
      const value = Buffer.from(encoded, "base64url").toString("utf8");
      (part.mimeType === "text/plain" ? plain : html).push(value);
    }
    for (const child of part.parts || []) visit(child, depth + 1);
  }
  visit(payload, 0);
  return {
    text: plain.length ? plain.join("\n").trim() : htmlToText(html.join("\n")),
    attachments,
  };
}

/** @param {string} html */
function htmlToText(html) {
  const text = [];
  let skip = "";
  // A linear token scan also handles malformed/unclosed script/style tags
  // without repeatedly searching the remaining message for a closing tag.
  let offset = 0;
  while (offset < html.length) {
    if (html[offset] === "<") {
      const end = html.indexOf(">", offset + 1);
      if (end === -1) {
        if (!skip) text.push(html.slice(offset));
        break;
      }
      const token = html.slice(offset, end + 1);
      offset = end + 1;
      const tag = /^<\s*(\/?)\s*([a-z0-9]+)/i.exec(token);
      if (!tag) continue;
      const name = tag[2].toLowerCase();
      if (skip) {
        if (tag[1] && name === skip) skip = "";
      } else if (!tag[1] && ["script", "style"].includes(name)) {
        skip = name;
      } else if (name === "br" || (tag[1] && ["p", "div", "li"].includes(name))) {
        text.push("\n");
      }
    } else {
      const next = html.indexOf("<", offset);
      const end = next === -1 ? html.length : next;
      if (!skip) text.push(html.slice(offset, end));
      offset = end;
    }
  }
  return text.join("")
    .replace(/&nbsp;/gi, " ").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/&amp;/gi, "&").trim();
}

/** @param {string} code */
function syncError(code) {
  return Object.assign(new Error(code), { code });
}

/**
 * @param {{
 *   service: SupportEmailService | null,
 *   logger: import('pino').Logger,
 *   intervalMs?: number,
 * }} deps
 */
function buildSupportEmailJob(deps) {
  /** @type {NodeJS.Timeout | null} */
  let timer = null;
  /** @type {Promise<{ processed: number } | null> | null} */
  let running = null;
  function runOnce() {
    if (!running) {
      running = (deps.service ? deps.service.sync() : Promise.resolve(null))
        .catch(async (err) => {
          // Do not log OAuth responses, tokens, message bodies or headers.
          const code = typeof err?.code === "string" && /^[a-z0-9_]{1,64}$/.test(err.code)
            ? err.code : "sync_failed";
          deps.logger.warn({ code }, "support_email_sync_failed");
          try { await deps.service?.reportFailure(code); } catch { /* Retry next poll. */ }
          return null;
        }).finally(() => { running = null; });
    }
    return running;
  }
  return {
    start() {
      if (timer) return;
      if (!deps.service) {
        deps.logger.info("support_email_disabled: configure SUPPORT_GMAIL_* to import incoming mail");
        return;
      }
      void runOnce();
      timer = setInterval(() => void runOnce(), deps.intervalMs || 60000);
      timer.unref();
      deps.logger.info("support_email_started");
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      if (running) await running;
    },
    runOnce,
  };
}

module.exports = { SupportEmailService, buildSupportEmailJob, messagePayload };
