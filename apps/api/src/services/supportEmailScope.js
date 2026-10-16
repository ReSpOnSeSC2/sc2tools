"use strict";

const crypto = require("crypto");

/** Durable delivery keys stay mailbox-scoped when the import label changes. @param {string} mailbox */
function supportEmailMailboxId(mailbox) {
  return crypto.createHash("sha256").update(mailbox).digest("hex");
}

/**
 * Checkpoints must never inherit an unrestricted or differently labeled scan.
 * @param {string} mailbox
 * @param {string} labelName
 */
function supportEmailStateId(mailbox, labelName) {
  return crypto.createHash("sha256").update(`${mailbox}\0${labelName}`).digest("hex");
}

module.exports = { supportEmailMailboxId, supportEmailStateId };
