"use strict";

const { MAX_LINE_CHARS } = require("./chatbot");
const { CommandCooldowns } = require("./chatCommands");
const { channelName, MAX_LENGTH, PlatformChatError } = require("./platformChat");
const { sha256 } = require("../util/hash");

const PLATFORMS = /** @type {const} */ (["twitch", "kick", "youtube"]);
const RECEIPT_TTL_SEC = 30 * 60;
const COMMAND = /^!([a-z][a-z0-9_]{0,23})(?:\s+(.{1,80}))?$/iu;
const MESSAGE_UUID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu;
const ROW_LENGTHS = { token: 512, platform: 10, source: 120, id: 300, user: 80, text: 106 };

/** @typedef {typeof PLATFORMS[number]} Platform */
/** @typedef {{token:string,platform:Platform,source:string,id:string,user:string,text:string}} ReplyEvent */
/** @typedef {Partial<Record<Platform,{enabled?:boolean,channel?:string,chatroomId?:number}>>} MultichatPreferences */

/** @param {unknown} field @param {number} limit */
function validField(field, limit) {
  return typeof field === "string" && Boolean(field.trim()) && field.length <= limit && !/[\p{Cc}\u2028\u2029]/u.test(field);
}

/** @param {ReplyEvent} event */
function hasSourceMessage(event) {
  return event.platform === "youtube" ? event.id.startsWith(`${event.source}:`) && event.id.length > event.source.length + 1
    : MESSAGE_UUID.test(event.id);
}

/** Authenticated owner input describes a row, never the outgoing text or a provider destination.
 * @param {unknown} value @returns {ReplyEvent|null} */
function readReplyEvent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = /** @type {Record<string,unknown>} */ (value);
  const fields = Object.entries(ROW_LENGTHS);
  if (Object.keys(row).length !== fields.length || !fields.every(([key, limit]) => validField(row[key], limit))) return null;
  const event = /** @type {ReplyEvent} */ (/** @type {unknown} */ (row));
  return PLATFORMS.includes(event.platform) && hasSourceMessage(event) && COMMAND.test(event.text.trim()) ? event : null;
}

/** @param {string} value */
function sameIdentity(value) { return value.trim().toLowerCase(); }

class ChatOwnerReplies {
  /** @param {{
   *   overlayTokens:Pick<import("./overlayTokens").OverlayTokensService,"resolve"|"withWrite">,
   *   users:Pick<import("./users").UsersService,"getPreferences">,
   *   commands:Pick<import("./chatCommandService").ChatCommandService,"answer">,
   *   platformChat:Pick<import("./platformChat").PlatformChatService,"sendCommandReply"|"assertCommandSource">,
   *   now?:()=>number,
   * }} deps */
  constructor(deps) {
    this.deps = deps;
    this.receipts = new CommandCooldowns(deps.now);
  }

  /** @param {string} userId @param {ReplyEvent} event */
  async send(userId, event) {
    const match = COMMAND.exec(event.text.trim());
    if (!match) return { status: "unknown" };
    const messageId = event.platform === "youtube" ? event.id : event.id.toLowerCase();
    const key = sha256(JSON.stringify([event.platform, messageId]));
    let claimed = false;
    if (!await this.ownsToken(userId, event.token)) return { status: "unavailable" };
    try {
      return await this.deps.overlayTokens.withWrite(event.token, async () => {
        if (!await this.ownsToken(userId, event.token)) return { status: "unavailable" };
        if (this.receipts.isActive(userId, key)) return { status: "already_answered" };
        if (await this.botAnswers(userId, event)) return { status: "bot_enabled" };
        const config = await this.chatPreferences(userId);
        return this.deps.platformChat.sendCommandReply(userId, event.platform, { source: event.source, messageId }, config, async identity => {
          const reply = await this.compose(userId, event, key, match, identity, config[event.platform]?.channel);
          claimed = Boolean(reply.text);
          return reply;
        });
      });
    } catch (error) {
      if (!(error instanceof PlatformChatError)) throw error;
      if (claimed && !error.deliveryUnknown) this.receipts.release(userId, key);
      return { status: error.deliveryUnknown ? "unconfirmed" : "failed", message: error.message };
    }
  }

  /** @param {string} userId @param {ReplyEvent} event @param {string} key
   * @param {RegExpExecArray} match @param {string} identity @param {unknown} channel */
  async compose(userId, event, key, match, identity, channel) {
    if (sameIdentity(event.user) === sameIdentity(identity)) return { status: "own_message", text: null };
    const limit = Math.min(MAX_LINE_CHARS, MAX_LENGTH[event.platform]);
    const reply = await this.deps.commands.answer(event.token, {
      command: match[1], argument: match[2], user: event.user, platform: event.platform,
    }, { ownerSend: { userId, limit } });
    if (!reply?.text) return { status: reply?.status || "unavailable", text: null };
    const status = await this.recheckSource(userId, event, channel);
    if (status) return { status, text: null };
    return this.receipts.claim(userId, key, RECEIPT_TTL_SEC, event.platform, "")
      ? reply : { status: "already_answered", text: null };
  }

  /** @param {string} userId @param {ReplyEvent} event @param {unknown} channel */
  async recheckSource(userId, event, channel) {
    const current = await this.chatPreferences(userId);
    if (current[event.platform]?.channel !== channel || !await this.ownsToken(userId, event.token)) {
      return "unavailable";
    }
    this.deps.platformChat.assertCommandSource(event.platform, event.source, current);
    return await this.botAnswers(userId, event) ? "bot_enabled" : null;
  }

  /** @param {string} userId */
  async chatPreferences(userId) {
    return /** @type {MultichatPreferences} */ (await this.deps.users.getPreferences(userId, "multichat") || {});
  }

  /** @param {string} userId @param {string} token */
  async ownsToken(userId, token) {
    return (await this.deps.overlayTokens.resolve(token))?.userId === userId;
  }

  /** @param {string} userId @param {ReplyEvent} event */
  async botAnswers(userId, event) {
    if (event.platform !== "twitch") return false;
    const bot = await this.deps.users.getPreferences(userId, "chatbot");
    return bot?.enabled === true && bot.replyCommands !== false
      && channelName(bot.channel || bot.username, "twitch") === channelName(event.source, "twitch");
  }
}

module.exports = { ChatOwnerReplies, readReplyEvent };
