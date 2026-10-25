import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
const require = createRequire(import.meta.url);
const registry = require("../../api/src/services/chatCommands.js");
const catalog = { commands: registry.CHAT_COMMANDS, platforms: registry.PLATFORMS, variables: registry.VARIABLES,
  reserved: [...(registry.RESERVED || [])], maxCustom: registry.MAX_CUSTOM_COMMANDS,
  defaults: registry.configuredCommands({ builtins: [], custom: [] }) };
await writeFile(new URL("../lib/multichat/chatCommandCatalog.generated.json", import.meta.url), `${JSON.stringify(catalog, null, 2)}\n`);
console.log(`Generated ${catalog.commands.length} chat commands from the API registry.`);
