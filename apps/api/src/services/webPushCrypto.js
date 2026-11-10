"use strict";

const crypto = require("crypto");

/**
 * Web Push message encryption (RFC 8291, ``aes128gcm``) and VAPID
 * authentication (RFC 8292) on node:crypto alone — no dependency.
 * ``__tests__/webPushCrypto.test.js`` pins the RFC 8291 Appendix A vector
 * byte for byte, and verifies the VAPID JWT signature.
 *
 * Keys use the format every Web Push tool prints: base64url, a 65-byte
 * uncompressed P-256 public key and its 32-byte private scalar.
 */

const RECORD_SIZE = 4096;
const JWT_LIFETIME_SEC = 12 * 60 * 60;

/** @param {Buffer} buf */
const b64url = (buf) => buf.toString("base64url");

/**
 * @param {unknown} value
 * @param {number} length
 * @returns {Buffer|null}
 */
function decodeKey(value, length) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+={0,2}$/.test(value)) return null;
  const buf = Buffer.from(value.replace(/=+$/, ""), "base64url");
  return buf.length === length ? buf : null;
}

/**
 * Validate a VAPID key pair and import the private key for ES256.
 * Returns null for anything malformed, including a pair whose halves do
 * not belong together — the push feature then stays off.
 *
 * @param {unknown} publicKey
 * @param {unknown} privateKey
 * @returns {{publicKey: string, keyObject: crypto.KeyObject}|null}
 */
function parseVapidKeys(publicKey, privateKey) {
  const pub = decodeKey(publicKey, 65);
  const priv = decodeKey(privateKey, 32);
  if (!pub || !priv || pub[0] !== 4) return null;
  try {
    const ecdh = crypto.createECDH("prime256v1");
    ecdh.setPrivateKey(priv);
    if (!ecdh.getPublicKey().equals(pub)) return null;
    const keyObject = crypto.createPrivateKey({
      key: { kty: "EC", crv: "P-256", d: b64url(priv), x: b64url(pub.subarray(1, 33)), y: b64url(pub.subarray(33)) },
      format: "jwk",
    });
    return { publicKey: b64url(pub), keyObject };
  } catch {
    return null;
  }
}

/** A fresh pair in the same format, for the owner's one-time setup. */
function generateVapidKeys() {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  return { publicKey: b64url(ecdh.getPublicKey()), privateKey: b64url(ecdh.getPrivateKey()) };
}

/**
 * ``Authorization: vapid t=<JWT>, k=<public key>`` for one push service.
 *
 * @param {{endpoint: string, subject: string, vapid: {publicKey: string, keyObject: crypto.KeyObject}, nowSec?: number}} input
 */
function vapidAuthorization(input) {
  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000);
  const header = b64url(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64url(Buffer.from(JSON.stringify({
    aud: new URL(input.endpoint).origin,
    exp: nowSec + JWT_LIFETIME_SEC,
    sub: input.subject,
  })));
  const unsigned = `${header}.${claims}`;
  const signature = crypto.sign("sha256", Buffer.from(unsigned), { key: input.vapid.keyObject, dsaEncoding: "ieee-p1363" });
  return `vapid t=${unsigned}.${b64url(signature)}, k=${input.vapid.publicKey}`;
}

/**
 * Encrypt one push message for a subscription (single record, RFC 8188).
 * ``ephemeralPrivateKey`` and ``salt`` exist only so the RFC test vector
 * can be reproduced; production calls always generate fresh ones.
 *
 * @param {string|Buffer} payload
 * @param {{p256dh: string, auth: string}} keys
 * @param {{ephemeralPrivateKey?: Buffer, salt?: Buffer}} [opts]
 * @returns {Buffer}
 */
function encryptPushPayload(payload, keys, opts = {}) {
  const uaPublic = decodeKey(keys.p256dh, 65);
  const authSecret = decodeKey(keys.auth, 16);
  if (!uaPublic || !authSecret) throw Object.assign(new Error("invalid_push_keys"), { code: "invalid_push_keys" });
  const ecdh = crypto.createECDH("prime256v1");
  if (opts.ephemeralPrivateKey) ecdh.setPrivateKey(opts.ephemeralPrivateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const salt = opts.salt || crypto.randomBytes(16);
  const sharedSecret = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync("sha256", sharedSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  // One record: the payload followed by the 0x02 last-record delimiter.
  const plaintext = Buffer.concat([Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8"), Buffer.from([2])]);
  if (plaintext.length + 16 > RECORD_SIZE - 86) throw Object.assign(new Error("push_payload_too_large"), { code: "push_payload_too_large" });
  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(RECORD_SIZE);
  return Buffer.concat([salt, recordSize, Buffer.from([asPublic.length]), asPublic, body]);
}

module.exports = { parseVapidKeys, generateVapidKeys, vapidAuthorization, encryptPushPayload, decodeKey };
