"use strict";

const { MATCHUPS } = require("./guideSlugs");

const DISCORD_INTERACTIONS_PATH = "/discord/interactions";
const DISCORD_API = "https://discord.com/api/v10";
const BUILD_COMMAND = Object.freeze({
  name: "build",
  description: "Find published SC2 Tools ladder build guides.",
  type: 1,
  integration_types: [0],
  contexts: [0],
  options: [{
    type: 3, name: "matchup", description: "Your race versus the opponent's race", required: true,
    choices: MATCHUPS.map(matchup => ({ name: matchup, value: matchup.toLowerCase() })),
  }],
});

/** @param {unknown} value @returns {value is string} */
function isDiscordSnowflake(value) {
  return typeof value === "string" && /^[1-9][0-9]{16,19}$/u.test(value);
}

/** Owner-provided public identity and verification key. Missing values keep the route inactive.
 * @param {NodeJS.ProcessEnv} env */
function parseDiscordInteractions(env) {
  const applicationId = env.DISCORD_APPLICATION_ID?.trim();
  const publicKey = env.DISCORD_INTERACTIONS_PUBLIC_KEY?.trim();
  return isDiscordSnowflake(applicationId) && typeof publicKey === "string" && /^[a-f0-9]{64}$/iu.test(publicKey)
    ? { applicationId, publicKey }
    : null;
}

/** A fixed path for logging and tracing, regardless of case, origin or query.
 * @param {unknown} value */
function isDiscordInteractionsRequest(value) {
  if (typeof value !== "string") return false;
  const path = value.replace(/^https?:\/\/[^/]+(?=\/)/iu, "").split(/[?#]/u, 1)[0];
  return /^\/(?:v1\/)?discord\/interactions\/?$/iu.test(path);
}

module.exports = { BUILD_COMMAND, DISCORD_API, DISCORD_INTERACTIONS_PATH, isDiscordInteractionsRequest, isDiscordSnowflake, parseDiscordInteractions };
