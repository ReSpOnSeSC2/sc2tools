"use strict";

const { parseArgs } = require("node:util");
const { BUILD_COMMAND, DISCORD_API, isDiscordSnowflake } = require("../src/config/discordInteractions");

/** @param {string[]} argv @param {NodeJS.ProcessEnv} env */
function mainOptions(argv, env) {
  const { values } = parseArgs({
    args: argv,
    options: { apply: { type: "boolean" }, guild: { type: "string" } },
  });
  const applicationId = env.DISCORD_APPLICATION_ID;
  if (!isDiscordSnowflake(applicationId)) throw new Error("Set DISCORD_APPLICATION_ID to the application ID.");
  if (values.guild !== undefined && !isDiscordSnowflake(values.guild)) throw new Error("Use a Discord guild ID with --guild.");
  const url = DISCORD_API + "/applications/" + applicationId
    + (values.guild ? "/guilds/" + values.guild : "") + "/commands";
  // Guild commands already have a guild-only installation and context.
  const { integration_types, contexts, ...guildCommand } = BUILD_COMMAND;
  return { apply: values.apply === true, url, command: values.guild ? guildCommand : { ...guildCommand, integration_types, contexts } };
}

/** @param {string[]} argv @param {NodeJS.ProcessEnv} env @param {typeof fetch} [send] */
async function register(argv, env, send = fetch) {
  const { apply, url, command } = mainOptions(argv, env);
  if (!apply) return JSON.stringify({ dryRun: true, method: "POST", url, command }, null, 2);
  const token = env.DISCORD_COMMANDS_ACCESS_TOKEN?.trim();
  if (!token) throw new Error("Set DISCORD_COMMANDS_ACCESS_TOKEN for --apply.");
  let response;
  try {
    response = await send(url, {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify(command),
      redirect: "error",
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new Error("Discord command registration could not connect.");
  }
  if (!response.ok) throw new Error("Discord command registration returned HTTP " + response.status + ".");
  return "Registered /build.";
}

if (require.main === module) {
  register(process.argv.slice(2), process.env).then(result => process.stdout.write(result + "\n"), error => {
    const message = error?.code?.startsWith("ERR_PARSE_ARGS") ? "Use [--guild GUILD_ID] [--apply]." : error.message;
    console.error(message);
    process.exitCode = 1;
  });
}

module.exports = { register };
