"use strict";

/**
 * Presigned access to the rendered SC2 3D alert media.
 *
 * The media is derived from rights-controlled StarCraft II assets, so it is
 * restricted to admin accounts and stored in a private R2 bucket that has no
 * public access and no custom domain. It is deliberately absent from both the
 * git repository (which is public) and apps/web/public (which is served
 * unauthenticated). The only way a browser obtains it is a short-lived
 * presigned URL minted here, exactly as replayFiles.js does for private
 * replay objects: bucket credentials never leave the API.
 *
 * Keys mirror the catalog paths declared in apps/web/lib/multichat/alerts.ts,
 * so the object `alerts/sc2-3d/zealot-dance-3d.webm` is returned under the key
 * `/alerts/sc2-3d/zealot-dance-3d.webm`. The client uses that path as its
 * lookup key, which keeps catalog and bucket in lockstep without either side
 * maintaining a hardcoded file list.
 */

const {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

/** Presigned URL lifetime. Short: a grant is cheap to re-request. */
const DEFAULT_EXPIRES_SEC = 300;

/**
 * How long a bucket listing is reused. The delivery set changes only when a
 * render batch is published, so a listing per request would be pure waste --
 * but a long TTL would hide a fresh upload for too long.
 */
const LISTING_CACHE_TTL_MS = 60_000;

/** Hard cap on objects in one grant; the delivery set is ~22 files. */
const MAX_OBJECTS = 200;

/** Only these extensions are ever signed. */
const ALLOWED_EXTENSIONS = /\.(webm|webp)$/i;

class AlertMediaStore {
  /**
   * @param {{
   *   client: import('@aws-sdk/client-s3').S3Client,
   *   bucket: string,
   *   prefix?: string,
   *   expiresSec?: number,
   *   signer?: typeof getSignedUrl,
   *   now?: () => number,
   * }} opts
   */
  constructor(opts) {
    this.client = opts.client;
    this.bucket = opts.bucket;
    this.prefix = String(opts.prefix || "alerts/sc2-3d").replace(/^\/+|\/+$/g, "");
    this.expiresSec = Number(opts.expiresSec) > 0
      ? Number(opts.expiresSec)
      : DEFAULT_EXPIRES_SEC;
    this.signer = opts.signer || getSignedUrl;
    this.now = opts.now || (() => Date.now());
    /** @type {{expiresAt: number, keys: string[]} | null} */
    this._listing = null;
    /** @type {Promise<string[]> | null} */
    this._listingInflight = null;
  }

  /**
   * List the delivery objects, cached briefly. Concurrent callers share one
   * in-flight request so a burst of overlay boots doesn't fan out to R2.
   *
   * @returns {Promise<string[]>} object keys, without a leading slash
   */
  async _keys() {
    const cached = this._listing;
    if (cached && cached.expiresAt > this.now()) return cached.keys;
    if (this._listingInflight) return this._listingInflight;

    const pending = (async () => {
      /** @type {string[]} */
      const keys = [];
      /** @type {string | undefined} */
      let continuationToken;
      do {
        const page = await this.client.send(
          new ListObjectsV2Command({
            Bucket: this.bucket,
            Prefix: `${this.prefix}/`,
            ContinuationToken: continuationToken,
            MaxKeys: MAX_OBJECTS,
          }),
        );
        for (const obj of page.Contents || []) {
          const key = obj && typeof obj.Key === "string" ? obj.Key : "";
          // Skip directory placeholders and anything that isn't delivery media.
          if (!key || key.endsWith("/")) continue;
          if (!ALLOWED_EXTENSIONS.test(key)) continue;
          keys.push(key);
          if (keys.length >= MAX_OBJECTS) break;
        }
        continuationToken = keys.length >= MAX_OBJECTS
          ? undefined
          : page.NextContinuationToken;
      } while (continuationToken);

      this._listing = {
        expiresAt: this.now() + LISTING_CACHE_TTL_MS,
        keys,
      };
      return keys;
    })().finally(() => {
      if (this._listingInflight === pending) this._listingInflight = null;
    });

    this._listingInflight = pending;
    return pending;
  }

  /**
   * Mint a grant: every delivery object mapped to a presigned GET URL.
   *
   * Callers MUST have already established that the requester is an admin.
   * This method performs no authorization of its own -- it is the mechanism,
   * not the gate.
   *
   * @returns {Promise<{urls: Record<string, string>, expiresIn: number}>}
   */
  async createGrant() {
    const keys = await this._keys();
    /** @type {Record<string, string>} */
    const urls = {};
    await Promise.all(keys.map(async (key) => {
      const url = await this.signer(
        this.client,
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
        { expiresIn: this.expiresSec },
      );
      urls[`/${key}`] = url;
    }));
    return { urls, expiresIn: this.expiresSec };
  }

  /** Drop the cached listing. Call after publishing a new render batch. */
  invalidate() {
    this._listing = null;
  }
}

/**
 * Build the store from resolved config, or return null when it is not
 * configured. A null store makes the endpoints answer 503 rather than crash
 * the app at boot: the 3D presets are an optional surface, and every other
 * alert preset is code-native and works without R2.
 *
 * Credentials: a dedicated Object Read only token scoped to the alert bucket
 * is preferred, because R2 tokens are bucket-scoped and the replay-store token
 * cannot read this bucket. Falls back to the shared R2 credentials when the
 * dedicated pair is unset.
 *
 * @param {{
 *   endpoint?: string, region?: string, accessKeyId?: string,
 *   secretAccessKey?: string, alertMediaBucket?: string,
 *   alertMediaPrefix?: string, alertMediaExpiresSec?: number,
 *   alertMediaAccessKeyId?: string, alertMediaSecretAccessKey?: string,
 * } | null | undefined} r2
 * @returns {AlertMediaStore | null}
 */
function buildAlertMediaStore(r2) {
  if (!r2 || !r2.endpoint || !r2.alertMediaBucket) return null;
  // Both halves of the dedicated pair must be present to be used; a half-set
  // pair is a misconfiguration, not a reason to silently sign with the wrong
  // credentials.
  const useDedicated = Boolean(
    r2.alertMediaAccessKeyId && r2.alertMediaSecretAccessKey,
  );
  const accessKeyId = useDedicated ? r2.alertMediaAccessKeyId : r2.accessKeyId;
  const secretAccessKey = useDedicated
    ? r2.alertMediaSecretAccessKey
    : r2.secretAccessKey;
  if (!accessKeyId || !secretAccessKey) return null;
  const client = new S3Client({
    region: r2.region || "auto",
    endpoint: r2.endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
  return new AlertMediaStore({
    client,
    bucket: r2.alertMediaBucket,
    prefix: r2.alertMediaPrefix,
    expiresSec: r2.alertMediaExpiresSec,
  });
}

module.exports = {
  AlertMediaStore,
  buildAlertMediaStore,
  DEFAULT_EXPIRES_SEC,
  LISTING_CACHE_TTL_MS,
  MAX_OBJECTS,
};
