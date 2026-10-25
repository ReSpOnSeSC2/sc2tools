import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import catalog from "../chatCommandCatalog.generated.json";
import { buildBioText, commandGroups } from "../commandsGuide";
import { newCustomCommand, nightbotSnippet, readChatCommands, serializeChatCommands, validateChatCommands } from "../chatCommandPreferences";
const require = createRequire(import.meta.url);
const registry = require("../../../../api/src/services/chatCommands.js");

describe("authoritative chat command catalog", () => {
  it("is fresh against the actual API registry, defaults, limits and reserved names", () => {
    expect(catalog).toEqual({ commands: registry.CHAT_COMMANDS, platforms: registry.PLATFORMS, variables: registry.VARIABLES,
      reserved: [...registry.RESERVED], maxCustom: registry.MAX_CUSTOM_COMMANDS, defaults: registry.configuredCommands({ builtins: [], custom: [] }) });
    expect(catalog.commands).toHaveLength(11);
    for (const command of catalog.commands) expect(buildBioText("protoss")).toContain(`!${command.id}`);
  });
  it("expands sparse preferences without carrying unknown fields into a save", () => {
    const value = readChatCommands({ builtins: [{ id: "mmr", trigger: "rating", enabled: false, secret: "discard" }], custom: [] });
    expect(value.builtins).toHaveLength(11); expect(value.builtins.find(row => row.id === "mmr")).toMatchObject({ trigger: "rating", enabled: false, cooldownSec: 15 });
    expect(JSON.stringify(serializeChatCommands(value))).not.toContain("secret");
    expect(commandGroups(value).find(group => group.id === "stats")!.commands.some(row => row.syntax.startsWith("!rating"))).toBe(false);
  });
  it("bio uses saved aliases and enabled custom names, retaining canonical aliases", () => {
    const value = readChatCommands({ builtins: [{ id: "mmr", trigger: "rating" }], custom: [] });
    value.custom.push({ ...newCustomCommand(), trigger: "greet", response: "Hello {user}" });
    expect(buildBioText("zerg", value)).toContain("!rating"); expect(buildBioText("zerg", value)).toContain("also !mmr");
    expect(buildBioText("zerg", value)).toContain("!greet — custom channel reply"); expect(buildBioText("zerg", value)).not.toContain("Hello {user}");
    value.builtins.forEach(command => { command.platforms = ["nightbot"]; });
    expect(buildBioText("zerg", value)).toContain("availability follows this channel's saved platform settings");
    expect(buildBioText("zerg", value)).not.toContain("work from Twitch, Kick");
    expect(buildBioText("zerg")).toContain("work from Twitch, Kick");
  });
  it("rejects reserved/colliding aliases, limits, markup and unknown variables", () => {
    const value = readChatCommands({}); value.custom.push({ ...newCustomCommand(), trigger: "rank", response: "Hi {user}" });
    expect(validateChatCommands(value)).toMatch(/reserved/); value.custom[0].trigger = "greet"; value.custom[0].response = "<b>Hi</b>";
    expect(validateChatCommands(value)).toMatch(/plain-text/); value.custom[0].response = "Hi {secret}"; expect(validateChatCommands(value)).toMatch(/Use only/);
    value.custom[0].response = "Hi {user}"; value.custom[0].cooldownSec = 4; expect(validateChatCommands(value)).toMatch(/5 to 3600/);
    value.custom = Array.from({ length: 26 }, (_, index) => ({ ...newCustomCommand(), trigger: `greet${index}`, response: "Hi" })); expect(validateChatCommands(value)).toMatch(/at most 25/);
  });
  it("copies an encoded Nightbot URL with documented input/user URL encoding", () => {
    expect(nightbotSnippet("https://api.fixture.invalid/", "token/secret", "rating")).toBe("$(urlfetch https://api.fixture.invalid/v1/chatbot/token%2Fsecret/rating?args=$(querystring)&user=$(querystring $(user)))");
  });
});
