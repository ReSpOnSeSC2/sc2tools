"use strict";

/**
 * Browser replay backup: the CORS rule on the private R2 replay bucket.
 *
 * Signed-in browsers PUT original .SC2Replay files straight to R2 through
 * the presigned URL from ``POST /v1/games/:id/replay-upload``
 * (services/replayFiles.js ``_signPendingUpload``). R2 only lets a web page
 * do that when the bucket carries a CORS rule that allows PUT from the
 * site's origins with the signed headers. This module:
 *
 *   - builds that rule from CORS_ALLOWED_ORIGINS (``desiredRule``);
 *   - adds it to the bucket when the R2 key may change bucket settings,
 *     never dropping any other rule (``ensureBrowserUploadCors``);
 *   - verifies it the way a browser does, with an OPTIONS preflight to the
 *     same host/path style the presigned PUTs use; no object is written
 *     (``probeBrowserUploadCors``);
 *   - caches the verified status for Admin Health and
 *     ``GET /v1/me/replay-archive-status`` (``BrowserUploadCorsStatus``).
 *
 * Logs carry statuses and error names/codes only: never keys, signed URLs
 * or bucket credentials.
 */

const {
  GetBucketCorsCommand,
  PutBucketCorsCommand,
  PutObjectCommand,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const { DEFAULTS } = require("../config/constants");

const BROWSER_UPLOAD_CORS_RULE_ID = "sc2tools-browser-replay-upload";
const UPLOAD_METHOD = "PUT";
/** Headers ``_signPendingUpload`` returns (minus content-length, which browsers set). */
const UPLOAD_HEADERS = Object.freeze([
  "content-type", "cache-control", "content-md5", "x-amz-meta-sha256",
]);
const EXPOSED_HEADERS = Object.freeze(["ETag"]);
const CORS_MAX_AGE_SECONDS = 3600;
const PROBE_TIMEOUT_MS = 5000;
const SETUP_TIMEOUT_MS = 15_000;
const PROBE_SIGN_EXPIRES_SEC = 60;
const PROBE_OBJECT_PATH = "_cors-probe/probe.SC2Replay";
const DEFAULT_REPLAY_PREFIX = "raw-replays/v1";
/** Preflights per check: the site's origins, bounded against a long allowlist. */
const MAX_PROBE_ORIGINS = 4;
const STATUS_MAX_AGE_MS = 10 * 60 * 1000;
/** Admin Health polls every 30 s; re-verify a little more often there. */
const ADMIN_STATUS_MAX_AGE_MS = 2 * 60 * 1000;
/** Floor for any caller-supplied max age, so reads never hammer R2. */
const MIN_REFRESH_INTERVAL_MS = 60 * 1000;
/** R2 documents up to 30 s for a CORS change to propagate. */
const PROPAGATION_RECHECK_MS = 30 * 1000;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
const MAX_ERROR_CODE_LENGTH = 64;
const MS_PER_SECOND = 1000;
const PERMISSION_CODES = new Set(["AccessDenied", "Unauthorized", "Forbidden"]);
/** Codes an S3-compatible store may use to refuse the optional rule ID. */
const REJECTED_SHAPE_CODES = new Set([
  "MalformedXML", "InvalidRequest", "InvalidArgument", "NotImplemented",
]);

const DETAIL = Object.freeze({
  NO_ORIGINS: "CORS_ALLOWED_ORIGINS lists no exact http(s) site origin",
  NO_PERMISSION: "The R2 key can't change bucket settings",
  AUTO_OFF: "Automatic setup is off (R2_BROWSER_CORS_AUTO)",
  NOT_APPLIED: "The upload rule was saved, but R2 is not applying it yet",
  RULE_PRESENT: "The bucket has an upload rule, but the browser check still fails",
  NOT_PERSISTED: "R2 accepted the upload rule but did not keep it",
});

/**
 * @typedef {import('@aws-sdk/client-s3').CORSRule} CorsRule
 * @typedef {import('@aws-sdk/client-s3').S3Client} S3Client
 * @typedef {{
 *   ID: string, AllowedOrigins: string[], AllowedMethods: string[],
 *   AllowedHeaders: string[], ExposeHeaders: string[], MaxAgeSeconds: number,
 * }} BrowserUploadRule
 * @typedef {'ready'|'missing_cors'|'no_permission'|'error'|'disabled'|'unknown'|'checking'} BrowserUploadState
 * @typedef {{
 *   status: BrowserUploadState, checkedAt: string|null, configuredAt?: string, detail?: string,
 * }} BrowserUploadStatusSnapshot
 * @typedef {{ status: 'ready'|'configured'|'no_permission'|'error', detail?: string }} EnsureResult
 * @typedef {{ status: 'ready'|'missing_cors'|'error', detail?: string }} ProbeResult
 * @typedef {{ status: BrowserUploadState, detail?: string, configured?: boolean }} CheckResult
 * @typedef {{ info: (obj: object, msg: string) => void, warn: (obj: object, msg: string) => void }} CorsLogger
 */

/**
 * The exact http(s) origins the upload rule allows: wildcards, blanks,
 * paths and duplicates are dropped; localhost only outside production.
 *
 * Example:
 *   browserUploadOrigins(["https://sc2tools.com/", "*", "http://localhost:3000"], { nodeEnv: "production" });
 *   // -> ["https://sc2tools.com"]
 *
 * @param {ReadonlyArray<string>|null|undefined} origins
 * @param {{ nodeEnv?: string }} [options]
 * @returns {string[]}
 */
function browserUploadOrigins(origins, options = {}) {
  const production = (options.nodeEnv ?? process.env.NODE_ENV) === "production";
  /** @type {string[]} */
  const out = [];
  for (const raw of origins || []) {
    const url = exactOriginUrl(raw);
    if (!url || out.includes(url.origin)) continue;
    if (production && isLocalHost(url.hostname)) continue;
    out.push(url.origin);
  }
  return out;
}

/** @param {unknown} raw @returns {URL|null} */
function exactOriginUrl(raw) {
  const value = String(raw || "").trim();
  if (!value || value.includes("*")) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  return isBareHttpOrigin(url) ? url : null;
}

/** An http(s) URL that is nothing but an origin (no path, query or credentials). @param {URL} url */
function isBareHttpOrigin(url) {
  return (url.protocol === "https:" || url.protocol === "http:")
    && url.pathname === "/"
    && !url.search
    && !url.hash
    && !url.username;
}

/** @param {string} hostname */
function isLocalHost(hostname) {
  return LOCAL_HOSTNAMES.has(hostname) || hostname.endsWith(".localhost");
}

/**
 * The CORS rule browser uploads need (see module comment).
 *
 * Example:
 *   desiredRule(["https://sc2tools.com"]).AllowedMethods; // -> ["PUT"]
 *
 * @param {ReadonlyArray<string>|null|undefined} origins
 * @param {{ nodeEnv?: string }} [options]
 * @returns {BrowserUploadRule}
 */
function desiredRule(origins, options = {}) {
  return {
    ID: BROWSER_UPLOAD_CORS_RULE_ID,
    AllowedOrigins: browserUploadOrigins(origins, options),
    AllowedMethods: [UPLOAD_METHOD],
    AllowedHeaders: [...UPLOAD_HEADERS],
    ExposeHeaders: [...EXPOSED_HEADERS],
    MaxAgeSeconds: CORS_MAX_AGE_SECONDS,
  };
}

/**
 * True when one existing rule allows every desired origin, PUT and every
 * desired header (case-insensitive; S3-style ``*`` wildcards count).
 *
 * Example:
 *   const wide = { AllowedOrigins: ["*"], AllowedMethods: ["PUT"], AllowedHeaders: ["*"] };
 *   ruleCovers([wide], desiredRule(["https://sc2tools.com"])); // -> true
 *
 * @param {ReadonlyArray<CorsRule>|null|undefined} existingRules
 * @param {Pick<BrowserUploadRule, 'AllowedOrigins'|'AllowedHeaders'>} desired
 * @returns {boolean}
 */
function ruleCovers(existingRules, desired) {
  if (!Array.isArray(existingRules)) return false;
  return existingRules.some((rule) => {
    if (!rule || typeof rule !== "object") return false;
    const methods = listOf(rule.AllowedMethods).map((m) => m.toUpperCase());
    if (!methods.includes(UPLOAD_METHOD) && !methods.includes("*")) return false;
    const origins = listOf(rule.AllowedOrigins);
    const headers = listOf(rule.AllowedHeaders);
    return desired.AllowedOrigins.every((o) => origins.some((p) => wildcardMatch(p, o)))
      && desired.AllowedHeaders.every((h) => headers.some((p) => wildcardMatch(p, h)));
  });
}

/**
 * Make sure the bucket carries the browser-upload rule: read the CORS
 * configuration, write it back with every other rule kept plus ours (only
 * a rule with our ID is replaced) when nothing covers it, then re-read.
 *
 * Example:
 *   await ensureBrowserUploadCors({ client, bucket, origins: ["https://sc2tools.com"] });
 *   // -> { status: "configured" }
 *
 * @param {{ client: S3Client, bucket: string, origins: ReadonlyArray<string>, nodeEnv?: string,
 *   logger?: CorsLogger, timeoutMs?: number }} opts
 * @returns {Promise<EnsureResult>}
 */
async function ensureBrowserUploadCors(opts) {
  const desired = desiredRule(opts.origins, { nodeEnv: opts.nodeEnv });
  if (desired.AllowedOrigins.length === 0) return { status: "error", detail: DETAIL.NO_ORIGINS };
  const deadline = AbortSignal.timeout(opts.timeoutMs ?? SETUP_TIMEOUT_MS);
  const io = { client: opts.client, bucket: opts.bucket, signal: deadline };
  try {
    const existing = await readCorsRules(io);
    if (ruleCovers(existing, desired)) return { status: "ready" };
    await writeCorsRules(io, mergeRules(existing, desired));
    if (!ruleCovers(await readCorsRules(io), desired)) {
      opts.logger?.warn({ status: "error" }, "replay_files_browser_cors_not_persisted");
      return { status: "error", detail: DETAIL.NOT_PERSISTED };
    }
    opts.logger?.info(
      { origins: desired.AllowedOrigins.length },
      "replay_files_browser_cors_configured",
    );
    return { status: "configured" };
  } catch (err) {
    return classifySetupError(err, opts.logger);
  }
}

/** @typedef {{ client: S3Client, bucket: string, signal: AbortSignal }} BucketIo */

/** @param {BucketIo} io @returns {Promise<CorsRule[]>} */
async function readCorsRules(io) {
  try {
    const out = await io.client.send(
      new GetBucketCorsCommand({ Bucket: io.bucket }),
      { abortSignal: io.signal },
    );
    return Array.isArray(out?.CORSRules) ? out.CORSRules : [];
  } catch (err) {
    if (errorCode(err) === "NoSuchCORSConfiguration") return [];
    if (httpStatusOf(err) === HTTP_NOT_FOUND) return [];
    throw err;
  }
}

/** @param {BucketIo} io @param {CorsRule[]} rules */
async function writeCorsRules(io, rules) {
  /** @param {CorsRule[]} corsRules */
  const put = (corsRules) => io.client.send(
    new PutBucketCorsCommand({
      Bucket: io.bucket,
      CORSConfiguration: { CORSRules: corsRules },
    }),
    { abortSignal: io.signal },
  );
  try {
    await put(rules);
  } catch (err) {
    if (!REJECTED_SHAPE_CODES.has(errorCode(err))) throw err;
    // A store that refuses the optional rule ID still gets the rule: the
    // rule's contents, not its ID, are what ruleCovers() verifies. Only our
    // own rule loses its ID; every other rule goes back exactly as read.
    await put(rules.map(withoutOwnRuleId));
  }
}

/** @param {CorsRule} rule @returns {CorsRule} */
function withoutOwnRuleId(rule) {
  if (rule.ID !== BROWSER_UPLOAD_CORS_RULE_ID) return rule;
  const copy = { ...rule };
  delete copy.ID;
  return copy;
}

/**
 * Every existing rule except an older copy of ours, then ours.
 *
 * @param {ReadonlyArray<CorsRule>} existing
 * @param {BrowserUploadRule} desired
 * @returns {CorsRule[]}
 */
function mergeRules(existing, desired) {
  return existing
    .filter((rule) => rule && rule.ID !== BROWSER_UPLOAD_CORS_RULE_ID)
    .concat([desired]);
}

/** @param {unknown} err @param {CorsLogger|undefined} logger @returns {EnsureResult} */
function classifySetupError(err, logger) {
  const code = errorCode(err);
  const httpStatus = httpStatusOf(err);
  const denied = PERMISSION_CODES.has(code)
    || httpStatus === HTTP_FORBIDDEN
    || httpStatus === HTTP_UNAUTHORIZED;
  const status = denied ? "no_permission" : "error";
  logger?.warn(
    { status, errorCode: code, httpStatus },
    "replay_files_browser_cors_setup_failed",
  );
  return denied
    ? { status: "no_permission", detail: DETAIL.NO_PERMISSION }
    : { status: "error", detail: `Automatic setup failed (${code})` };
}

/**
 * Browser-style preflight for a presigned replay PUT: signs a harmless
 * probe key with the product's S3 client (same host/path style as real
 * uploads), strips the signature, and sends OPTIONS with the site origin
 * and the signed headers. Writes nothing.
 *
 * Example:
 *   await probeBrowserUploadCors({ client, bucket, keyPrefix: "raw-replays/v1", origin: "https://sc2tools.com" });
 *   // -> { status: "ready" }
 *
 * @param {{ client: S3Client, bucket: string, keyPrefix?: string, origin: string,
 *   fetchImpl?: typeof fetch, timeoutMs?: number, signer?: typeof getSignedUrl }} opts
 * @returns {Promise<ProbeResult>}
 */
async function probeBrowserUploadCors(opts) {
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? fetch;
  let url;
  try {
    url = await probeUrl(opts);
  } catch (err) {
    return { status: "error", detail: `Could not sign the probe URL (${errorCode(err)})` };
  }
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "OPTIONS",
      headers: {
        Origin: opts.origin,
        "Access-Control-Request-Method": UPLOAD_METHOD,
        "Access-Control-Request-Headers": UPLOAD_HEADERS.join(","),
      },
      redirect: "manual",
      signal,
    });
    // The preflight body is irrelevant; release the connection.
    void res.body?.cancel().catch(() => undefined);
    if (preflightAllows(res, opts.origin)) return { status: "ready" };
    return {
      status: "missing_cors",
      detail: `The browser check from ${opts.origin} was refused (HTTP ${res.status})`,
    };
  } catch (err) {
    const detail = signal.aborted
      ? `The browser check timed out after ${timeoutMs / MS_PER_SECOND} s`
      : `The browser check failed (${errorCode(err)})`;
    return { status: "error", detail };
  }
}

/**
 * @param {{ client: S3Client, bucket: string, keyPrefix?: string, signer?: typeof getSignedUrl }} opts
 * @returns {Promise<string>}
 */
async function probeUrl(opts) {
  const prefix = String(opts.keyPrefix || DEFAULT_REPLAY_PREFIX).replace(/^\/+|\/+$/g, "");
  const command = new PutObjectCommand({
    Bucket: opts.bucket,
    Key: `${prefix}-pending/${PROBE_OBJECT_PATH}`,
  });
  const signer = opts.signer ?? getSignedUrl;
  const url = new URL(await signer(opts.client, command, { expiresIn: PROBE_SIGN_EXPIRES_SEC }));
  url.search = "";
  url.hash = "";
  return url.toString();
}

/**
 * The status a verified probe and the setup attempt add up to. The probe
 * is the source of truth for "ready"; setup only explains a failure.
 *
 * @param {EnsureResult|null} ensured  null when automatic setup is off
 * @param {ProbeResult} probe
 * @returns {CheckResult}
 */
function combineResults(ensured, probe) {
  const configured = ensured?.status === "configured";
  if (probe.status === "ready") return { status: "ready", configured };
  if (probe.status === "error") return { status: "error", detail: probe.detail, configured };
  if (!ensured) return { status: "missing_cors", detail: DETAIL.AUTO_OFF };
  if (ensured.status === "no_permission") return { status: "no_permission", detail: DETAIL.NO_PERMISSION };
  if (ensured.status === "configured") return { status: "missing_cors", detail: DETAIL.NOT_APPLIED, configured };
  if (ensured.status === "ready") return { status: "missing_cors", detail: DETAIL.RULE_PRESENT };
  return { status: "missing_cors", detail: ensured.detail };
}

/**
 * Cached, verified browser-upload CORS status for one replay bucket.
 * ``refresh()`` runs setup (when enabled) and then the preflight probe;
 * ``getStatus()`` is synchronous and re-checks in the background once
 * the last check is older than ``maxAgeMs``. The first check is started by
 * the boot hook (server.js); a process that never started one (tests, a
 * one-off script) never calls R2 from a read. Never throws.
 *
 * Example:
 *   const cors = new BrowserUploadCorsStatus({ client, bucket, keyPrefix, origins });
 *   await cors.refresh(); cors.getStatus().status; // -> "ready"
 */
class BrowserUploadCorsStatus {
  /**
   * @param {{ client: S3Client, bucket: string, keyPrefix?: string, origins: ReadonlyArray<string>,
   *   nodeEnv?: string, autoConfigure?: boolean, logger?: CorsLogger, fetchImpl?: typeof fetch,
   *   signer?: typeof getSignedUrl, now?: () => number, sleep?: (ms: number) => Promise<void>,
   *   probeTimeoutMs?: number, recheckDelayMs?: number }} opts
   */
  constructor(opts) {
    this.opts = opts;
    this.rule = desiredRule(opts.origins, { nodeEnv: opts.nodeEnv });
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms).unref()));
    /** @type {BrowserUploadStatusSnapshot} */
    this.snapshot = { status: "unknown", checkedAt: null };
    /** @type {Promise<BrowserUploadStatusSnapshot>|null} */
    this.inFlight = null;
    /** @type {number|null} */
    this.lastAttemptAt = null;
  }

  /**
   * The cached status (a copy); starts a background re-check when stale.
   *
   * Example:
   *   cors.getStatus({ maxAgeMs: ADMIN_STATUS_MAX_AGE_MS }).status; // -> "ready"
   *
   * @param {{ maxAgeMs?: number }} [options]
   * @returns {BrowserUploadStatusSnapshot}
   */
  getStatus(options = {}) {
    const maxAgeMs = Math.max(MIN_REFRESH_INTERVAL_MS, options.maxAgeMs ?? STATUS_MAX_AGE_MS);
    const started = this.lastAttemptAt !== null;
    if (started && !this.inFlight && this.now() - Number(this.lastAttemptAt) >= maxAgeMs) {
      void this.refresh();
    }
    return { ...this.snapshot };
  }

  /**
   * Check now (single-flight: concurrent callers share one check).
   *
   * Example:
   *   const { status, checkedAt } = await cors.refresh();
   *
   * @returns {Promise<BrowserUploadStatusSnapshot>}
   */
  refresh() {
    if (this.inFlight) return this.inFlight;
    this.lastAttemptAt = this.now();
    if (this.snapshot.checkedAt === null) this.snapshot = { status: "checking", checkedAt: null };
    this.inFlight = this.check()
      .catch((err) => /** @type {CheckResult} */ ({
        status: "error",
        detail: `Check failed (${errorCode(err)})`,
      }))
      .then((result) => this.record(result))
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  /** @returns {Promise<CheckResult>} */
  async check() {
    if (this.rule.AllowedOrigins.length === 0) return { status: "error", detail: DETAIL.NO_ORIGINS };
    const auto = this.opts.autoConfigure ?? DEFAULTS.R2_BROWSER_CORS_AUTO;
    const ensured = auto
      ? await ensureBrowserUploadCors({ ...this.opts, origins: this.rule.AllowedOrigins })
      : null;
    let probe = await this.probeAll();
    if (ensured?.status === "configured" && probe.status === "missing_cors") {
      await this.sleep(this.opts.recheckDelayMs ?? PROPAGATION_RECHECK_MS);
      probe = await this.probeAll();
    }
    return combineResults(ensured, probe);
  }

  /** Every site origin must pass; the first failure explains the status. @returns {Promise<ProbeResult>} */
  async probeAll() {
    for (const origin of this.rule.AllowedOrigins.slice(0, MAX_PROBE_ORIGINS)) {
      const result = await probeBrowserUploadCors({
        ...this.opts,
        origin,
        timeoutMs: this.opts.probeTimeoutMs,
      });
      if (result.status !== "ready") return result;
    }
    return { status: "ready" };
  }

  /** @param {CheckResult} result @returns {BrowserUploadStatusSnapshot} */
  record(result) {
    const checkedAt = new Date(this.now()).toISOString();
    const configuredAt = result.configured ? checkedAt : this.snapshot.configuredAt;
    /** @type {BrowserUploadStatusSnapshot} */
    const next = { status: result.status, checkedAt };
    if (configuredAt) next.configuredAt = configuredAt;
    if (result.detail) next.detail = result.detail;
    this.snapshot = next;
    return { ...next };
  }
}

/** The status reported while the replay store itself is off. */
function disabledBrowserUploadStatus() {
  return /** @type {BrowserUploadStatusSnapshot} */ ({ status: "disabled", checkedAt: null });
}

/**
 * The status to report for an optional service (``disabled`` without one).
 *
 * Example:
 *   browserUploadStatusOf(null).status; // -> "disabled"
 *
 * @param {Pick<BrowserUploadCorsStatus, 'getStatus'>|null|undefined} service
 * @param {{ maxAgeMs?: number }} [options]
 * @returns {BrowserUploadStatusSnapshot}
 */
function browserUploadStatusOf(service, options) {
  return service ? service.getStatus(options) : disabledBrowserUploadStatus();
}

/**
 * Build the status service for a configured replay store (null without one).
 *
 * Example:
 *   const cors = buildBrowserUploadCorsStatus({ replayFiles, config, logger });
 *
 * @param {{ replayFiles: import('./replayFiles').ReplayFilesService|null, logger?: CorsLogger,
 *   config: { corsAllowedOrigins?: string[], nodeEnv?: string, r2BrowserCorsAuto?: boolean } }} deps
 * @returns {BrowserUploadCorsStatus|null}
 */
function buildBrowserUploadCorsStatus(deps) {
  if (!deps.replayFiles) return null;
  return new BrowserUploadCorsStatus({
    client: deps.replayFiles.client,
    bucket: deps.replayFiles.bucket,
    keyPrefix: deps.replayFiles.prefix,
    origins: deps.config.corsAllowedOrigins || [],
    nodeEnv: deps.config.nodeEnv,
    autoConfigure: deps.config.r2BrowserCorsAuto ?? DEFAULTS.R2_BROWSER_CORS_AUTO,
    logger: deps.logger,
  });
}

/**
 * Boot hook: fire-and-forget first check, then one structured log line.
 * Resolves (never rejects) so it can never crash or block boot.
 *
 * Example:
 *   void startBrowserUploadCorsCheck(services.browserUploadCors, logger);
 *
 * @param {Pick<BrowserUploadCorsStatus, 'refresh'>|null|undefined} service
 * @param {CorsLogger} logger
 * @returns {Promise<void>}
 */
async function startBrowserUploadCorsCheck(service, logger) {
  if (!service) return;
  try {
    const snapshot = await service.refresh();
    logger.info(
      { status: snapshot.status, configured: Boolean(snapshot.configuredAt) },
      "replay_files_browser_cors",
    );
  } catch (err) {
    logger.warn({ errorCode: errorCode(err) }, "replay_files_browser_cors_boot_failed");
  }
}

/**
 * Case-insensitive match with at most one S3-style ``*`` wildcard.
 *
 * Example:
 *   wildcardMatch("x-amz-*", "x-amz-meta-sha256"); // -> true
 *
 * @param {string} pattern
 * @param {string} value
 * @returns {boolean}
 */
function wildcardMatch(pattern, value) {
  const p = String(pattern).trim().toLowerCase();
  const v = String(value).trim().toLowerCase();
  if (p === v) return true;
  const star = p.indexOf("*");
  if (star < 0 || p.indexOf("*", star + 1) >= 0) return false;
  const head = p.slice(0, star);
  const tail = p.slice(star + 1);
  return v.length >= head.length + tail.length && v.startsWith(head) && v.endsWith(tail);
}

/** @param {unknown} value @returns {string[]} */
function listOf(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

/** @param {string} raw @returns {string[]} */
function csvList(raw) {
  return raw.split(",").map((part) => part.trim()).filter(Boolean);
}

/**
 * What a browser requires of a preflight answer for our PUT: a 2xx, the
 * origin (or ``*``) allowed, PUT allowed and every signed header allowed.
 *
 * @param {{ ok: boolean, headers: { get(name: string): string|null } }} res
 * @param {string} origin
 * @returns {boolean}
 */
function preflightAllows(res, origin) {
  if (!res.ok) return false;
  const allowOrigin = String(res.headers.get("access-control-allow-origin") || "").trim();
  if (allowOrigin !== "*" && allowOrigin.toLowerCase() !== origin.toLowerCase()) return false;
  const methods = csvList(String(res.headers.get("access-control-allow-methods") || ""));
  if (!methods.some((method) => method === "*" || method.toUpperCase() === UPLOAD_METHOD)) {
    return false;
  }
  const headers = csvList(String(res.headers.get("access-control-allow-headers") || ""));
  return UPLOAD_HEADERS.every((header) => headers.some((p) => wildcardMatch(p, header)));
}

/**
 * A log-safe error identifier: the S3 code, Node code or error name only
 * (never the message, which can carry a URL or key).
 *
 * @param {unknown} err
 * @returns {string}
 */
function errorCode(err) {
  const e = /** @type {{ Code?: unknown, code?: unknown, name?: unknown, cause?: { code?: unknown } }} */ (
    err && typeof err === "object" ? err : {}
  );
  const raw = [e.Code, e.code, e.cause?.code, e.name].find((v) => typeof v === "string" && v);
  const safe = String(raw || "unknown").replace(/[^A-Za-z0-9_.-]/g, "").slice(0, MAX_ERROR_CODE_LENGTH);
  return safe || "unknown";
}

/** @param {unknown} err @returns {number|null} */
function httpStatusOf(err) {
  const status = /** @type {{ $metadata?: { httpStatusCode?: unknown } }} */ (err || {})
    .$metadata?.httpStatusCode;
  return typeof status === "number" ? status : null;
}

module.exports = {
  BROWSER_UPLOAD_CORS_RULE_ID,
  UPLOAD_HEADERS,
  STATUS_MAX_AGE_MS,
  ADMIN_STATUS_MAX_AGE_MS,
  MIN_REFRESH_INTERVAL_MS,
  PROPAGATION_RECHECK_MS,
  MAX_PROBE_ORIGINS,
  DETAIL,
  BrowserUploadCorsStatus,
  browserUploadOrigins,
  desiredRule,
  ruleCovers,
  ensureBrowserUploadCors,
  probeBrowserUploadCors,
  combineResults,
  disabledBrowserUploadStatus,
  browserUploadStatusOf,
  buildBrowserUploadCorsStatus,
  startBrowserUploadCorsCheck,
  _internals: { wildcardMatch, preflightAllows, errorCode, mergeRules },
};
