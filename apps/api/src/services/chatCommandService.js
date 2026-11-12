"use strict";

const { CHAT_COMMANDS, PLATFORMS, VARIABLES, plainText, sanitizeChatCommands, configuredCommands, CommandCooldowns } = require("./chatCommands");
const { clip, MAX_LINE_CHARS } = require("./chatbot");
const { SC2TOOLS_LINK } = require("./chatCommandLinks");

const LINK_COOLDOWN_SEC = 120;

/** @param {string|null} text @param {string|null} link */
function formatReply(text, link) {
  if (!text) return null;
  const available = MAX_LINE_CHARS - (link ? link.length + 1 : 0);
  return link && available > 0 ? `${clip(text, available)} ${link}` : clip(text);
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
   * @param {string} token @param {{command:string,argument?:string,platform?:string,user?:string,onStream?:boolean}} input
   * @param {{previewOwner?:string}} [options]
   * @returns {Promise<{status:string,text:string|null,command?:string}|null>} */
  async answer(token, input, options = {}) {
    const owner = await this.deps.overlayTokens.resolve(token);
    if (!owner || (options.previewOwner && options.previewOwner !== owner.userId)) return null;
    const prefs = sanitizeChatCommands(await this.deps.users.getPreferences(owner.userId, "chatCommands"));
    const trigger = String(input.command || "").replace(/^!/, "").trim().toLowerCase();
    if (!/^[a-z][a-z0-9_]{0,23}$/.test(trigger)) return { status: "unknown", text: null };
    const custom = prefs.custom.find(command => command.trigger === trigger);
    const builtin = custom ? undefined : configuredCommands(prefs).find(command => command.trigger === trigger || command.id === trigger || command.aliases.some(alias => alias === trigger));
    const command = builtin || custom;
    const platform = input.platform || "nightbot";
    if (!command || !PLATFORMS.includes(platform)) return { status: "unknown", text: null };
    const id = builtin?.id || command.trigger;
    if (!command.enabled || !command.platforms.includes(platform) || (input.onStream && !command.answerOnStream)) return { status: "disabled", text: null, command: id };
    const viewer = plainText(input.user).slice(0, 80);
    // Chat and the on-stream card each answer once; a connected IRC bot must
    // not consume the matching Browser Source's answer to the same message.
    const lane = `${owner.userId}:${input.onStream ? "stream" : "chat"}`;
    const cooldownId = `${builtin ? "builtin" : "custom"}:${id}`;
    if (!options.previewOwner && !this.cooldowns.claim(lane, cooldownId, command.cooldownSec, platform, viewer)) return { status: "cooldown", text: null, command: id };
    const includeLink = command.includeLink && !input.onStream && (Boolean(options.previewOwner) || !this.cooldowns.isActive(lane, "linked-reply"));
    const reply = custom
      ? { text: await this.customLine(token, custom.response, viewer), link: null }
      : await this.builtinReply(token, id, String(input.argument || "").slice(0, 80), includeLink);
    // A rotation/revocation during composition cannot leak a late token reply.
    const current = await this.deps.overlayTokens.resolve(token);
    if (!current || current.userId !== owner.userId) return null;
    const link = reply.link && (options.previewOwner || this.cooldowns.claim(lane, "linked-reply", LINK_COOLDOWN_SEC, platform, "")) ? reply.link : null;
    return { status: "reply", text: formatReply(reply.text, link), command: id };
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
