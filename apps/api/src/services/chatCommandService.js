"use strict";

const { CHAT_COMMANDS, PLATFORMS, VARIABLES, plainText, sanitizeChatCommands, configuredCommands, CommandCooldowns } = require("./chatCommands");
const { clip } = require("./chatbot");

class ChatCommandService {
  /** @param {{
   * overlayTokens:Pick<import('./overlayTokens').OverlayTokensService,'resolve'>,
   * users:Pick<import('./users').UsersService,'getPreferences'>,
   * chatbot:Pick<import('./chatbot').ChatbotService,'commandLine'>,
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
    const builtin = configuredCommands(prefs).find(command => command.trigger === trigger || command.id === trigger || command.aliases.some(alias => alias === trigger));
    const custom = !builtin ? prefs.custom.find(command => command.trigger === trigger) : undefined;
    const command = builtin || custom;
    const platform = input.platform || "nightbot";
    if (!command || !PLATFORMS.includes(platform)) return { status: "unknown", text: null };
    const id = builtin?.id || command.trigger;
    if (!command.enabled || !command.platforms.includes(platform) || (input.onStream && !command.answerOnStream)) return { status: "disabled", text: null, command: id };
    const viewer = plainText(input.user).slice(0, 80);
    // Chat and the on-stream card each answer once; a connected IRC bot must
    // not consume the matching Browser Source's answer to the same message.
    const lane = `${owner.userId}:${input.onStream ? "stream" : "chat"}`;
    if (!options.previewOwner && !this.cooldowns.claim(lane, id, command.cooldownSec, platform, viewer)) return { status: "cooldown", text: null, command: id };
    let text;
    if (custom) {
      /** @type {Record<string,string>} */ const values = { user: viewer || "viewer" };
      const variables = [...new Set([...custom.response.matchAll(/\{([^{}]*)\}/g)].map(match => match[1]))];
      await Promise.all(variables.filter(variable => VARIABLES.includes(variable) && variable !== "user").map(async variable => {
        values[variable] = await this.deps.chatbot.commandLine(token, variable) || "Unavailable";
      }));
      text = custom.response.replace(/\{([^{}]*)\}/g, (_match, variable) => values[variable] || "Unavailable");
    } else {
      text = await this.deps.chatbot.commandLine(token, id, String(input.argument || "").slice(0, 80));
    }
    // A rotation/revocation during composition cannot leak a late token reply.
    const current = await this.deps.overlayTokens.resolve(token);
    if (!current || current.userId !== owner.userId) return null;
    return { status: "reply", text: text ? clip(plainText(text)) : null, command: id };
  }

  /** @param {unknown} raw */
  metadata(raw) { return { commands: configuredCommands(sanitizeChatCommands(raw)), variables: VARIABLES, maxCustom: 25 }; }
}

module.exports = { ChatCommandService, CHAT_COMMANDS };
