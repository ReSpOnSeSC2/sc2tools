"use strict";

/**
 * One-time owner setup for Web Push (docs/notifications.md).
 *
 *   node scripts/generate-vapid-keys.js
 *
 * Prints a fresh VAPID key pair. Put both values in the API environment
 * with a contact subject, then redeploy:
 *
 *   WEB_PUSH_VAPID_PUBLIC_KEY=<public>
 *   WEB_PUSH_VAPID_PRIVATE_KEY=<private>   (secret; never commit it)
 *   WEB_PUSH_VAPID_SUBJECT=mailto:you@example.com
 *
 * Changing the pair later makes every browser subscription invalid; the
 * API removes them as push services reject them, and users turn push on
 * again in Settings.
 */

const { generateVapidKeys } = require("../src/services/webPushCrypto");

const keys = generateVapidKeys();
process.stdout.write(`WEB_PUSH_VAPID_PUBLIC_KEY=${keys.publicKey}\nWEB_PUSH_VAPID_PRIVATE_KEY=${keys.privateKey}\n`);
