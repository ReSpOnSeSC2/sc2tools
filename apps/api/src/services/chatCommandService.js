"use strict";

const { CHAT_COMMANDS, PLATFORMS, VARIABLES, plainText, sanitizeChatCommands, configuredCommands, CommandCooldowns } = require("./chatCommands");
const { clip, MAX_LINE_CHARS } = require("./chatbot");
const { SC2TOOLS_LINK } = require("./chatCommandLinks");

const LINK_COOLDOWN_SEC = 120;
const PUBLIC_REPLY_COMMANDS = new Set(["mmr", "build", "record", "winrate", "streak", "peak", "uptime", "sc2tools"]);
/** @typedef {{command:string,argument?:string,platform?:string,user?:string,onStream?:boolean}} ReplyInput */
/** @typedef {{previewOwner?:string,ownerSend?:{userId:string,limit:number}}} ReplyOptions */

/** @param {string|null} text @param {string|null} link @param {number} [limit] */
function formatReply(text, link, limit = MAX_LINE_CHARS) {
  if (!text) return null;
  const available = limit - (link ? link.length + 1 : 0);
  return link && available > 0 ? `${clip(text, available)} ${link}` : clip(text, limit);
}

/** @param {{id:string}|undefined} builtin @param {{response:string}|undefined} custom */
function isPublicReply(builtin, custom) {
  return custom ? !custom.response.includes("{opponent}") : Boolean(builtin && PUBLIC_REPLY_COMMANDS.has(builtin.id));
}

/** @param {ReturnType<typeof sanitizeChatCommands>} prefs @param {ReplyInput} input */
function selectCommand(prefs, input) {
  const trigger = String(input.command || "").replace(/^!/, "").trim().toLowerCase();
  const platform = input.platform || "nightbot";
  if (!/^[a-z][a-z0-9_]{0,23}$/.test(trigger) || !PLATFORMS.includes(platform)) return null;
  const custom = prefs.custom.find(command => command.trigger === trigger);
  const builtin = custom ? undefined : configuredCommands(prefs).find(command =>
    command.trigger === trigger || command.id === trigger || command.aliases.some(alias => alias === trigger));
  const command = builtin || custom;
  return command ? { id: builtin?.id || command.trigger, builtin, custom, command, platform } : null;
}

/** @typedef {NonNullable<ReturnType<typeof selectCommand>>} SelectedCommand */
/** @param {SelectedCommand} selected @param {ReplyInput} input @param {ReplyOptions} options */
function declineReason({ builtin, custom, command, platform }, input, options) {
  if (!command.enabled || !command.platforms.includes(platform) || (input.onStream && !command.answerOnStream)) return "disabled";
  return options.ownerSend && !isPublicReply(builtin, custom) ? "private_command" : null;
}

class ChatCommandService {
  /** @param {{
   * overlayTokens:Pick<import('./overlayTokens').OverlayTokensService,'resolve'>,
   * users:Pick<import('./users').UsersService,'getPreferences'>,
   * chatbot:Pick<import('./chatbot').ChatbotService,'commandLine'> & Partial<Pick<import('./chatbot').ChatbotService,'buildReply'>>,
   * now?:()=>number,
   * }} deps */
  constructor(deps) { this.deps = deps; this.cooldowns = new CommandCooldowns(deps.now); }

  /** Preview uses the same saved settings and composer, with no cooldown or external send.
   * @param {string} token @param {ReplyInput} input @param {ReplyOptions} [options]
   * @returns {Promise<{status:string,text:string|null,command?:string}|null>} */
  async answer(token, input, options = {}) {
    const owner = await this.deps.overlayTokens.resolve(token);
    const expectedOwner = options.previewOwner || options.ownerSend?.userId;
    if (!owner || (expectedOwner && expectedOwner !== owner.userId)) return null;
    const prefs = sanitizeChatCommands(await this.deps.users.getPreferences(owner.userId, "chatCommands"));
    const selected = selectCommand(prefs, input);
    if (!selected) return { status: "unknown", text: null };
    const status = declineReason(selected, input, options);
    if (status) return { status, text: null, command: selected.id };
    return this._renderReply(token, owner.userId, selected, input, options);
  }

  /** @param {string} token @param {string} userId @param {SelectedCommand} selected
   * @param {ReplyInput} input @param {ReplyOptions} options */
  async _renderReply(token, userId, selected, input, options) {
    const { builtin, command, id, platform } = selected;
    const viewer = plainText(input.user).slice(0, 80);
    // Chat and the on-stream card each answer once; a connected IRC bot must
    // not consume the matching Browser Source's answer to the same message.
    const lane = `${userId}:${input.onStream ? "stream" : "chat"}`;
    const cooldownId = `${builtin ? "builtin" : "custom"}:${id}`;
    const preview = Boolean(options.previewOwner);
    if (!preview && !this.cooldowns.claim(lane, cooldownId, command.cooldownSec, platform, viewer)) return { status: "cooldown", text: null, command: id };
    const reply = await this._compose(token, selected, input, { viewer, lane, preview, publicReply: Boolean(options.ownerSend) });
    // A rotation/revocation during composition cannot leak a late token reply.
    if ((await this.deps.overlayTokens.resolve(token))?.userId !== userId) return null;
    const link = this._admitLink(reply.link, preview, lane, platform);
    return { status: "reply", text: formatReply(reply.text, link, options.ownerSend?.limit), command: id };
  }

  /** @param {string} token @param {SelectedCommand} selected @param {ReplyInput} input
   * @param {{viewer:string,lane:string,preview:boolean,publicReply:boolean}} context */
  async _compose(token, { command, custom, id }, input, { viewer, lane, preview, publicReply }) {
    if (custom) return { text: await this.customLine(token, custom.response, publicReply ? "" : viewer), link: null };
    const includeLink = command.includeLink && !input.onStream && (preview || !this.cooldowns.isActive(lane, "linked-reply"));
    return this.builtinReply(token, id, String(input.argument || "").slice(0, 80), includeLink);
  }

  /** @param {string|null} link @param {boolean} preview @param {string} lane @param {string} platform */
  _admitLink(link, preview, lane, platform) {
    return link && (preview || this.cooldowns.claim(lane, "linked-reply", LINK_COOLDOWN_SEC, platform, "")) ? link : null;
  }

  /** @param {string} token @param {string} template @param {string} viewer */
  async customLine(token, template, viewer) {
    /** @type {Record<string,string>} */ const values = { user: viewer || "viewer" };
    const variables = [...new Set([...template.matchAll(/\{([^{}]*)\}/g)].map(match => match[1]))];
    await Promise.all(variables.filter(variable => VARIABLES.includes(variable) && variable !== "user").map(async variable => {
      values[variable] = await this.deps.chatbot.commandLine(token, variable) || "Unavailable";
    }));
    return template.replace(/\{([^{}]*)\}/g, (_match, variable) => values[variable] || "Unavailable");
  }

  /** @param {string} token @param {string} id @param {string} argument @param {boolean} includeLink */
  async builtinReply(token, id, argument, includeLink) {
    if (id === "sc2tools") return { text: "SC2 Tools analyzes StarCraft II replays and powers stream overlays.", link: includeLink ? SC2TOOLS_LINK : null };
    if (id === "build" && includeLink && this.deps.chatbot.buildReply) {
      return await this.deps.chatbot.buildReply(token, true) ?? { text: null, link: null };
    }
    return { text: await this.deps.chatbot.commandLine(token, id, argument), link: null };
  }

  /** @param {unknown} raw */
  metadata(raw) { return { commands: configuredCommands(sanitizeChatCommands(raw)), variables: VARIABLES, maxCustom: 25 }; }
}

module.exports = { ChatCommandService, CHAT_COMMANDS };
