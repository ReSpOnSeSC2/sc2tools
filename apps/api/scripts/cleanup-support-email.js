#!/usr/bin/env node
"use strict";

// Run inside the API service's environment. No .env files or message bodies
// are read, exported, or backed up. Gmail is accessed through GETs only.
const { MongoClient } = require("mongodb");
const { COLLECTIONS, DEFAULTS } = require("../src/config/constants");
const { parseSupportEmailConfig } = require("../src/config/loader");
const { SupportEmailService } = require("../src/services/supportEmail");

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const MESSAGE_ID = /^[a-zA-Z0-9_-]{1,64}$/;

/** @typedef {Pick<SupportEmailService, "accessToken"|"getJson">} GmailReader */
/** @typedef {import('../src/services/supportEmail').SupportEmailConfig} SupportConfig */

/** @param {string} code @returns {never} */
function fail(code) { throw Object.assign(new Error(code), { code }); }

/**
 * Validate the actual OAuth mailbox and resolve the exact approved custom label.
 * @param {GmailReader} gmail @param {SupportConfig} config @param {string} token
 * @returns {Promise<string>}
 */
async function approvedLabel(gmail, config, token) {
  const profile = await gmail.getJson(`${GMAIL_BASE}/profile`, token);
  if (profile.emailAddress?.toLowerCase() !== config.mailbox) fail("mailbox_mismatch");
  const result = await gmail.getJson(`${GMAIL_BASE}/labels`, token);
  if (!Array.isArray(result.labels)) fail("gmail_labels_invalid");
  const matches = result.labels.filter((/** @type {any} */ label) => label.name === config.labelName
    && (!label.type || label.type === "user"));
  if (matches.length !== 1 || !matches[0].id) fail("gmail_label_missing");
  return matches[0].id;
}

/**
 * Read the complete labeled ID set before considering any imported copies.
 * @param {GmailReader} gmail @param {string} labelId @param {string} token
 */
async function approvedMessageIds(gmail, labelId, token) {
  /** @type {Set<string>} */
  const ids = new Set();
  /** @type {Set<string>} */
  const pages = new Set();
  /** @type {string|undefined} */
  let pageToken;
  do {
    const params = new URLSearchParams({ labelIds: labelId, maxResults: "500", includeSpamTrash: "true" });
    if (pageToken) params.set("pageToken", pageToken);
    const result = await gmail.getJson(`${GMAIL_BASE}/messages?${params}`, token);
    if (result.messages !== undefined && !Array.isArray(result.messages)) fail("gmail_messages_invalid");
    for (const message of result.messages || []) {
      if (typeof message.id !== "string" || !MESSAGE_ID.test(message.id)) fail("gmail_message_id_invalid");
      ids.add(message.id);
    }
    pageToken = result.nextPageToken;
    if (pageToken !== undefined && (typeof pageToken !== "string" || !pageToken)) fail("gmail_page_token_invalid");
    if (pageToken && (pages.has(pageToken) || pages.size >= 10000)) fail("gmail_pagination_incomplete");
    if (pageToken) pages.add(pageToken);
  } while (pageToken);
  return ids;
}

/**
 * Recheck only label metadata; never download a message body.
 * @param {GmailReader} gmail @param {string} id @param {string} labelId @param {string} token
 */
async function currentlyApproved(gmail, id, labelId, token) {
  let message;
  try {
    message = await gmail.getJson(`${GMAIL_BASE}/messages/${id}?format=minimal`, token);
  } catch (err) {
    if (/** @type {{code?:unknown}} */ (err)?.code === "gmail_http_404") return false;
    throw err;
  }
  if (message.id !== id || (message.labelIds !== undefined && !Array.isArray(message.labelIds))) {
    fail("gmail_message_metadata_invalid");
  }
  return (message.labelIds || []).includes(labelId);
}

/**
 * Remove only copied support-mailbox email events absent from the approved
 * label. Dry-run is the default. Reads complete successfully before deletes;
 * apply also rechecks each label membership immediately before its delete.
 * @param {{adminEvents: import('mongodb').Collection, gmail: GmailReader, config: SupportConfig, apply?: boolean}} deps
 */
async function cleanupSupportEmail({ adminEvents, gmail, config, apply = false }) {
  if (!config?.mailbox || !config.labelName?.trim()) fail("support_email_config_required");
  const token = await gmail.accessToken();
  const labelId = await approvedLabel(gmail, config, token);
  const approvedIds = await approvedMessageIds(gmail, labelId, token);
  const scope = { type: "user_message", "payload.source": "email", "payload.mailbox": config.mailbox };
  const rows = await adminEvents.find(scope, {
    projection: { _id: 1, "payload.gmailMessageId": 1, "payload.email": 1, "payload.subject": 1 },
  }).sort({ _id: 1 }).toArray();
  const candidates = [];
  let invalidReferences = 0;
  for (const row of rows) {
    const id = row.payload?.gmailMessageId;
    if (typeof id !== "string" || !MESSAGE_ID.test(id)) { invalidReferences += 1; continue; }
    if (approvedIds.has(id) || await currentlyApproved(gmail, id, labelId, token)) continue;
    candidates.push(row);
  }
  const preview = candidates.map((row) => ({
    gmailMessageId: row.payload.gmailMessageId,
    from: typeof row.payload.email === "string" ? row.payload.email : "",
    subject: typeof row.payload.subject === "string" ? row.payload.subject : "",
  }));
  let deletedCount = 0;
  let newlyApproved = 0;
  if (apply && candidates.length) {
    if (await approvedLabel(gmail, config, token) !== labelId) fail("gmail_label_changed");
    for (const row of candidates) {
      const id = row.payload.gmailMessageId;
      if (await currentlyApproved(gmail, id, labelId, token)) { newlyApproved += 1; continue; }
      const result = await adminEvents.deleteOne({ ...scope, _id: row._id, "payload.gmailMessageId": id });
      deletedCount += result.deletedCount;
    }
  }
  return { preview, deletedCount, newlyApproved, invalidReferences };
}

/** @param {string[]} args */
function parseArguments(args) {
  if (args.some((arg) => !["--apply", "--dry-run", "--help"].includes(arg))
    || (args.includes("--apply") && args.includes("--dry-run"))) fail("invalid_arguments");
  return { apply: args.includes("--apply"), help: args.includes("--help") };
}

/** @param {string[]} [args] @param {NodeJS.ProcessEnv} [env] */
async function main(args = process.argv.slice(2), env = process.env) {
  const options = parseArguments(args);
  if (options.help) {
    process.stdout.write("Usage: node scripts/cleanup-support-email.js [--dry-run | --apply]\n"
      + "Uses the API service's MONGODB_* and SUPPORT_GMAIL_* environment.\n"
      + "Default: preview copied emails outside the configured support label.\n"
      + "--apply deletes only those imported admin Messages copies; Gmail stays unchanged.\n");
    return;
  }
  const config = parseSupportEmailConfig(env);
  if (!config) fail("support_email_config_required");
  if (!env.MONGODB_URI?.trim()) fail("mongodb_config_required");
  const client = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  try {
    await client.connect();
    const adminEvents = client.db(env.MONGODB_DB || DEFAULTS.DB_NAME).collection(COLLECTIONS.ADMIN_EVENTS);
    // The read-only client methods do not touch the importer's DB or state.
    const gmail = new SupportEmailService({
      db: /** @type {any} */ (null), adminEvents: /** @type {any} */ (null), config,
    });
    const result = await cleanupSupportEmail({ adminEvents, gmail, config, apply: options.apply });
    process.stdout.write(`${JSON.stringify(result.preview, null, 2)}\n`);
    process.stderr.write(`${options.apply ? "Apply" : "Dry run"}: ${result.preview.length} candidates; `
      + `${result.deletedCount} deleted; ${result.newlyApproved} newly labeled copies preserved; `
      + `${result.invalidReferences} invalid references preserved.\n`);
  } finally {
    await client.close();
  }
}

if (require.main === module) {
  main().catch((err) => {
    const code = typeof err?.code === "string" && /^[a-z0-9_]{1,64}$/.test(err.code)
      ? err.code : "cleanup_failed";
    // Provider/driver errors can contain credentials or email content.
    process.stderr.write(`Support email cleanup stopped: ${code}\n`);
    process.exitCode = 1;
  });
}

module.exports = { cleanupSupportEmail, parseArguments, main };
