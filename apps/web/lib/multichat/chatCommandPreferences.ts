import catalog from "./chatCommandCatalog.generated.json";
export { catalog as CHAT_COMMAND_CATALOG };
export type CommandOptions = { trigger: string; enabled: boolean; cooldownSec: number; platforms: string[]; answerOnStream: boolean };
export type BuiltinCommand = CommandOptions & { id: string };
export type CustomCommand = CommandOptions & { response: string };
export type ChatCommandPreferences = { builtins: BuiltinCommand[]; custom: CustomCommand[] };
export type CommandReply = { status: "reply" | "disabled" | "unknown" | "cooldown"; text: string | null; command?: string };
const trigger = (value: unknown) => typeof value === "string" ? value.trim().replace(/^!/, "").toLowerCase() : "";
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const options = (value: unknown, fallback: CommandOptions): CommandOptions => {
  const row = record(value), name = trigger(row.trigger);
  return { trigger: /^[a-z][a-z0-9_]{0,23}$/.test(name) ? name : fallback.trigger,
    enabled: typeof row.enabled === "boolean" ? row.enabled : fallback.enabled,
    cooldownSec: typeof row.cooldownSec === "number" && Number.isInteger(row.cooldownSec) && row.cooldownSec >= 5 && row.cooldownSec <= 3600 ? row.cooldownSec : fallback.cooldownSec,
    platforms: Array.isArray(row.platforms) ? [...new Set(row.platforms.filter((platform): platform is string => typeof platform === "string" && catalog.platforms.includes(platform)))] : [...fallback.platforms],
    answerOnStream: typeof row.answerOnStream === "boolean" ? row.answerOnStream : fallback.answerOnStream };
};
export const newCustomCommand = (): CustomCommand => ({ trigger: "", response: "", enabled: true, cooldownSec: 15, platforms: [...catalog.platforms], answerOnStream: true });

/** Expand sparse saved overrides for display; never import server code into a browser. */
export function readChatCommands(raw: unknown): ChatCommandPreferences {
  const value = record(raw), builtins = Array.isArray(value.builtins) ? value.builtins.slice(0, catalog.commands.length).map(record) : [];
  return { builtins: catalog.defaults.map(command => ({ id: command.id, ...options(builtins.find(row => row.id === command.id), command) })),
    custom: (Array.isArray(value.custom) ? value.custom : []).slice(0, catalog.maxCustom).map(row => {
      const value = record(row); return { ...options(value, newCustomCommand()), response: typeof value.response === "string" ? value.response.slice(0, 1000) : "" };
    }).filter(row => !!row.trigger && !!row.response) };
}

/** Client feedback mirrors exported registry names; the server remains the final validator. */
export function validateChatCommands(value: ChatCommandPreferences): string | null {
  if (value.custom.length > catalog.maxCustom) return `Save at most ${catalog.maxCustom} custom commands.`;
  const reserved = new Set([...catalog.reserved, ...catalog.commands.flatMap(command => [command.id, ...command.aliases])]), used = new Set<string>();
  for (const row of [...value.builtins, ...value.custom]) {
    const name = trigger(row.trigger), own = "id" in row ? row.id : null;
    if (!/^[a-z][a-z0-9_]{0,23}$/.test(name)) return "Command names must start with a letter and contain up to 24 letters, numbers or underscores.";
    if (used.has(name) || reserved.has(name) && name !== own) return `!${name} is already reserved or used by another command.`;
    used.add(name);
    if (!Number.isInteger(row.cooldownSec) || row.cooldownSec < 5 || row.cooldownSec > 3600) return "Cooldowns must be whole numbers from 5 to 3600 seconds.";
    if (row.platforms.some(platform => !catalog.platforms.includes(platform))) return "Choose supported platforms.";
    if ("response" in row) {
      const response = row.response.trim();
      if (!response || response.length > 1000 || /[<>\u0000-\u001f\u007f-\u009f]/.test(response)) return "Custom replies need one plain-text line, up to 1,000 characters, without markup.";
      if (/[{}]/.test(response.replace(/\{(?:user|mmr|record|opponent|streak)\}/g, ""))) return `Use only ${catalog.variables.map(variable => `{${variable}}`).join(", ")} variables.`;
    }
  }
  return null;
}

export function serializeChatCommands(value: ChatCommandPreferences): ChatCommandPreferences {
  return { builtins: value.builtins.map(row => ({ ...row, trigger: trigger(row.trigger), platforms: [...row.platforms] })),
    custom: value.custom.map(row => ({ ...row, trigger: trigger(row.trigger), response: row.response.replace(/\s+/g, " ").trim(), platforms: [...row.platforms] })) };
}

export function nightbotSnippet(apiBase: string, token: string, name: string) {
  // Nightbot's QueryString variable URL-encodes both arguments and the caller.
  return `$(urlfetch ${apiBase.replace(/\/$/, "")}/v1/chatbot/${encodeURIComponent(token)}/${encodeURIComponent(name)}?args=$(querystring)&user=$(querystring $(user)))`;
}
