"use strict";

const { PlatformCredentialVault } = require("./platformCredentialVault");
const { PlatformEventsService } = require("./platformEvents");
const oauthDefault = require("./platformOauthClients");
const webhooksDefault = require("./platformWebhooks");

/** @typedef {'twitch'|'kick'|'youtube'} Platform */
/** @type {readonly Platform[]} */
const PLATFORMS = Object.freeze(["twitch", "kick", "youtube"]);
const TWITCH_TOKEN_VALIDATION_INTERVAL_MS = 60 * 60 * 1000;

class PlatformIntegrationError extends Error {
  /** @param {number} status @param {string} code @param {string} message */
  constructor(status, code, message) {
    super(message);
    this.name = "PlatformIntegrationError";
    this.status = status;
    this.code = code;
  }
}

class PlatformIntegrationsService {
  /**
   * @param {{
   *   platformConnections: import('mongodb').Collection,
   *   platformOauthStates: import('mongodb').Collection,
   *   platformWebhookReceipts: import('mongodb').Collection,
   *   platformEvents: import('mongodb').Collection,
   * }} db
   * @param {{
   *   config: Record<string, any>,
   *   overlayTokens: {list: (userId: string) => Promise<Array<Record<string, any>>>},
   *   io?: import('socket.io').Server,
   *   logger?: import('pino').Logger,
   *   fetchImpl?: typeof fetch,
   *   now?: () => number,
   *   oauth?: typeof oauthDefault,
   *   webhooks?: typeof webhooksDefault,
   *   kickPublicKey?: string,
   * }} deps
   */
  constructor(db, deps) {
    this.config = deps.config || { enabled: false };
    this.logger = deps.logger || null;
    this.fetchImpl = deps.fetchImpl || fetch;
    this.now = deps.now || Date.now;
    this.oauth = deps.oauth || oauthDefault;
    this.webhooks = deps.webhooks || webhooksDefault;
    this.kickPublicKey = deps.kickPublicKey;
    this.vault = this.config.enabled
      ? new PlatformCredentialVault(db, {
        encryptionKey: this.config.encryptionKey,
        now: this.now,
      })
      : null;
    this.events = new PlatformEventsService(db, {
      io: deps.io,
      overlayTokens: deps.overlayTokens,
      now: this.now,
      logger: this.logger || undefined,
    });
    /** @type {ReturnType<typeof setInterval>|null} */
    this.youtubeTimer = null;
    /** @type {Promise<{checked:number}>|null} */
    this.youtubePoll = null;
    /** @type {AbortController|null} */
    this.youtubePollAbort = null;
    /** @type {ReturnType<typeof setInterval>|null} */
    this.healthTimer = null;
    /** @type {Promise<{checked:number}>|null} */
    this.healthPoll = null;
    /** @type {AbortController|null} */
    this.healthPollAbort = null;
    /** @type {Map<string, Promise<void>>} */
    this.connectionLocks = new Map();
    // Twitch requires OAuth token validation at process startup and hourly.
    // Metadata provides the hourly clock; this process-local set forces the
    // first check after every deploy even if another instance wrote recently.
    /** @type {Set<string>} */
    this.twitchValidatedRevisions = new Set();
  }

  /** @param {Platform} platform */
  isConfigured(platform) {
    assertPlatform(platform);
    return Boolean(this.config.enabled && this.config[platform] && this.vault);
  }

  /** @param {string} userId */
  async statuses(userId) {
    const connected = this.vault ? await this.vault.statuses(userId) : [];
    const byPlatform = new Map(connected.map((row) => [row.platform, row]));
    return {
      platforms: PLATFORMS.map((platform) => ({
        platform,
        configured: this.isConfigured(platform),
        connected: false,
        ready: false,
        platformUserId: "",
        platformUserName: "",
        scopes: [],
        expiresAt: null,
        connectedAt: null,
        lastSyncedAt: null,
        lastError: null,
        ...(byPlatform.get(platform) || {}),
      })),
    };
  }

  /** @param {string} userId @param {Platform} platform */
  async begin(userId, platform) {
    this._requireConfigured(platform);
    const vault = this._vault();
    if (!userId) throw integrationError(401, "auth_required", "Sign in first");
    const provider = this.config[platform];
    let verifier = null;
    let challenge = null;
    if (platform === "kick") {
      const pair = this.oauth.createPkcePair();
      verifier = pair.verifier;
      challenge = pair.challenge;
    }
    const state = await vault.createOauthState({
      userId,
      platform,
      redirectUri: provider.redirectUri,
      codeVerifier: verifier,
    });
    let authorizeUrl;
    if (platform === "twitch") {
      authorizeUrl = this.oauth.buildTwitchAuthorizeUrl(provider, state);
    } else if (platform === "kick") {
      authorizeUrl = this.oauth.buildKickAuthorizeUrl(provider, state, challenge || "");
    } else {
      authorizeUrl = this.oauth.buildYoutubeAuthorizeUrl(provider, state);
    }
    return { platform, authorizeUrl };
  }

  /**
   * Consume a provider-denied OAuth state without installing a connection.
   * ``consumeOauthState`` includes the provider in its atomic delete filter,
   * so an error callback for one platform cannot invalidate another
   * platform's pending authorization.
   * @param {Platform} platform
   * @param {unknown} value
   */
  async abandonOauth(platform, value) {
    this._requireConfigured(platform);
    const state = String(value || "");
    if (!state || state.length > 256) return false;
    return Boolean(await this._vault().consumeOauthState(state, platform));
  }

  /** @param {Platform} platform @param {{code?:unknown,state?:unknown}} input */
  async complete(platform, input) {
    this._requireConfigured(platform);
    const vault = this._vault();
    const code = String(input?.code || "");
    const state = String(input?.state || "");
    if (!code || code.length > 2_048 || !state || state.length > 256) {
      throw integrationError(400, "oauth_callback_invalid", "The authorization response was incomplete");
    }
    const pending = await vault.consumeOauthState(state, platform);
    if (!pending) {
      throw integrationError(400, "oauth_state_invalid", "This connection link expired or was already used");
    }
    const provider = this.config[platform];
    let token;
    let identity;
    if (platform === "twitch") {
      token = await this.oauth.exchangeTwitchCode(provider, code, this.fetchImpl);
      identity = await this.oauth.validateTwitchUserToken(token.accessToken, this.fetchImpl);
      token.scopes = identity.scopes;
    } else if (platform === "kick") {
      if (!pending.codeVerifier) {
        throw integrationError(400, "oauth_verifier_missing", "The Kick connection expired; try again");
      }
      token = await this.oauth.exchangeKickCode(
        provider,
        code,
        pending.codeVerifier,
        this.fetchImpl,
      );
      identity = await this.oauth.getKickCurrentUser(token.accessToken, this.fetchImpl);
      if (!token.scopes.length) token.scopes = [...this.oauth.KICK_SCOPES];
    } else {
      token = await this.oauth.exchangeYoutubeCode(provider, code, this.fetchImpl);
      identity = await this.oauth.getYoutubeCurrentChannel(token.accessToken, this.fetchImpl);
      if (!token.scopes.length) token.scopes = [...this.oauth.YOUTUBE_SCOPES];
    }

    await this._withConnectionLock(pending.userId, platform, () =>
      this._installConnection({
        userId: pending.userId,
        platform,
        provider,
        token,
        identity,
      }));
    return { userId: pending.userId, platform };
  }

  /**
   * Install one completed OAuth grant while holding the per-user/provider
   * lock. A different previously connected provider identity is revoked before
   * its encrypted row is replaced, so switching accounts cannot orphan a live
   * grant that SC2 Tools can no longer disconnect.
   * @param {{
   *   userId:string,
   *   platform:Platform,
   *   provider:{clientId:string,clientSecret:string,redirectUri:string,callbackUrl?:string,webhookSecret?:string},
   *   token:{accessToken:string,refreshToken?:string|null,expiresAt?:Date|null,scopes?:string[]},
   *   identity:{userId:string,userName?:string},
   * }} input
   */
  async _installConnection(input) {
    const vault = this._vault();
    const previous = await vault.getConnection(input.userId, input.platform);
    const changedIdentity = previous
      && previous.platformUserId !== String(input.identity.userId);
    const replacedRevocableToken = previous
      && input.platform !== "youtube"
      && previous.accessToken !== input.token.accessToken;
    // Twitch and Kick revoke individual tokens, so also retire a replaced
    // same-account token. Google revocation is grant-wide and would invalidate
    // the just-issued same-account token, so only revoke it on account switch.
    if (previous && (changedIdentity || replacedRevocableToken)) {
      try {
        await this._revokeConnection(input.platform, previous);
      } catch (err) {
        this._log(
          "warn",
          { platform: input.platform, err: safeMessage(err) },
          "previous official platform grant revocation failed during account switch",
        );
      }
    }

    await vault.saveConnection(input.userId, input.platform, {
      ...input.token,
      platformUserId: input.identity.userId,
      platformUserName: input.identity.userName,
      metadata: input.platform === "youtube"
        ? { youtubeInitialized: false, youtubeSeenIds: [], lastError: null }
        : {
          subscriptionsReady: false,
          lastError: null,
          ...(input.platform === "twitch"
            ? { lastTokenValidatedAt: new Date(this.now()) }
            : {}),
        },
    });
    const installed = await vault.getConnection(input.userId, input.platform);
    if (!installed) throw new Error("The platform connection could not be stored");
    const revision = installed.connectionRevision;
    if (input.platform === "twitch") {
      this.twitchValidatedRevisions.add(revision);
    }

    try {
      if (input.platform === "twitch") {
        assertTwitchRequiredScopes(input.token.scopes, this.oauth.TWITCH_SCOPES);
        const appAccessToken = await this.oauth.getTwitchAppToken(
          input.provider,
          this.fetchImpl,
        );
        await this.oauth.reconcileTwitchEventSubscriptions({
          broadcasterUserId: input.identity.userId,
          appAccessToken,
          clientId: input.provider.clientId,
          callbackUrl: String(input.provider.callbackUrl || ""),
          webhookSecret: String(input.provider.webhookSecret || ""),
          fetchImpl: this.fetchImpl,
        });
        await vault.updateMetadata(input.userId, input.platform, {
          subscriptionsReady: true,
          lastError: null,
          lastSyncedAt: new Date(this.now()),
        }, revision);
      } else if (input.platform === "kick") {
        await this.oauth.subscribeKickEvents(installed.accessToken, this.fetchImpl);
        await vault.updateMetadata(input.userId, input.platform, {
          subscriptionsReady: true,
          lastError: null,
          lastSyncedAt: new Date(this.now()),
        }, revision);
      } else {
        // Seed the public-subscriber cursor immediately. Historical public
        // subscribers must not all fire as fresh alerts after first connect.
        await this._pollYoutubeConnection({ ...installed, userId: input.userId });
      }
    } catch (err) {
      const message = safeMessage(err);
      const stillCurrent = await vault.updateMetadata(input.userId, input.platform, {
        subscriptionsReady: false,
        lastError: message,
      }, revision);
      // A separate instance may have installed a newer connection while this
      // provider call was in flight. Never report or write the old result over
      // that newer grant.
      if (!stillCurrent) return;
      throw integrationError(
        Number(/** @type {any} */ (err)?.status) || 502,
        String(/** @type {any} */ (err)?.code || `${input.platform}_setup_failed`),
        `The ${platformLabel(input.platform)} account connected, but notification setup did not finish. Reconnect to retry.`,
      );
    }
  }

  /** @param {string} userId @param {Platform} platform */
  async disconnect(userId, platform) {
    this._requireConfigured(platform);
    return this._withConnectionLock(userId, platform, async () => {
      const vault = this._vault();
      const connection = await vault.getConnection(userId, platform);
      if (connection) {
        try {
          await this._revokeConnection(platform, connection);
        } catch (err) {
          // Local disconnect must still succeed when a provider is unavailable
          // or the token was already revoked outside SC2 Tools.
          this._log(
            "warn",
            { platform, err: safeMessage(err) },
            "official platform token revocation failed",
          );
        }
      }
      if (platform === "twitch" && connection?.connectionRevision) {
        this.twitchValidatedRevisions.delete(connection.connectionRevision);
      }
      return vault.disconnect(userId, platform, connection?.connectionRevision || "");
    });
  }

  /** @param {Record<string,unknown>} headers @param {Buffer|string} rawBody */
  async handleTwitchWebhook(headers, rawBody) {
    this._requireConfigured("twitch");
    const vault = this._vault();
    const verified = this.webhooks.verifyTwitchWebhook({
      headers,
      rawBody,
      secret: this.config.twitch.webhookSecret,
      nowMs: this.now(),
    });
    const payload = this.webhooks.parseWebhookJson(rawBody);
    if (verified.messageType === "webhook_callback_verification") {
      const challenge = String(payload.challenge || "");
      if (!challenge || challenge.length > 1_024) {
        throw integrationError(400, "twitch_challenge_invalid", "Invalid Twitch challenge");
      }
      return { status: 200, body: challenge, contentType: "text/plain" };
    }
    const platformUserId = twitchBroadcasterId(payload);
    const userId = await vault.findOwnerByPlatformIdentity("twitch", platformUserId);
    if (verified.messageType === "revocation") {
      if (userId) {
        await vault.updateMetadata(userId, "twitch", {
          subscriptionsReady: false,
          lastError: `Twitch stopped notifications: ${String(payload.subscription?.status || "revoked").slice(0, 120)}`,
        });
      }
      await vault.claimWebhookReceipt("twitch", verified.messageId);
      return { status: 204 };
    }
    if (userId) {
      const event = this.webhooks.normalizeTwitchEvent(
        verified.subscriptionType || payload.subscription?.type,
        payload,
        verified.messageId,
      );
      if (event) await this.events.publish(userId, event);
    }
    // Claim after the durable event insert. A database failure before this
    // point remains retryable; concurrent retries are still suppressed by the
    // platformEvents unique index before any socket fan-out.
    await vault.claimWebhookReceipt("twitch", verified.messageId);
    return { status: 204 };
  }

  /** @param {Record<string,unknown>} headers @param {Buffer|string} rawBody */
  async handleKickWebhook(headers, rawBody) {
    this._requireConfigured("kick");
    const vault = this._vault();
    const verified = this.webhooks.verifyKickWebhook({
      headers,
      rawBody,
      publicKey: this.kickPublicKey,
      nowMs: this.now(),
    });
    const payload = this.webhooks.parseWebhookJson(rawBody);
    const platformUserId = kickBroadcasterId(payload);
    const userId = await vault.findOwnerByPlatformIdentity("kick", platformUserId);
    if (userId) {
      const event = this.webhooks.normalizeKickEvent(
        verified.eventType,
        payload,
        verified.messageId,
      );
      if (event) await this.events.publish(userId, event);
    }
    await vault.claimWebhookReceipt("kick", verified.messageId);
    return { status: 204 };
  }

  start() {
    if (this.isConfigured("youtube") && !this.youtubeTimer) {
      const interval = Math.max(60_000, Number(this.config.youtubePollIntervalMs) || 300_000);
      const tick = () => void this.pollYoutubeOnce().catch((err) => {
        this._log("warn", { err: safeMessage(err) }, "YouTube subscriber poll failed");
      });
      this.youtubeTimer = setInterval(tick, interval);
      this.youtubeTimer.unref?.();
      tick();
    }
    if ((this.isConfigured("twitch") || this.isConfigured("kick")) && !this.healthTimer) {
      // The subscription repair interval is configurable, but Twitch's token
      // policy still requires validation no less frequently than hourly.
      const interval = Math.min(
        TWITCH_TOKEN_VALIDATION_INTERVAL_MS,
        Math.max(
          60_000,
          Number(this.config.providerHealthIntervalMs) || 5 * 60 * 1000,
        ),
      );
      const tick = () => void this.reconcileProviderHealthOnce().catch((err) => {
        this._log("warn", { err: safeMessage(err) }, "platform subscription health check failed");
      });
      this.healthTimer = setInterval(tick, interval);
      this.healthTimer.unref?.();
      tick();
    }
  }

  async stop() {
    if (this.youtubeTimer) clearInterval(this.youtubeTimer);
    this.youtubeTimer = null;
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
    this.youtubePollAbort?.abort();
    this.healthPollAbort?.abort();
    if (this.youtubePoll) await this.youtubePoll.catch(() => {});
    if (this.healthPoll) await this.healthPoll.catch(() => {});
  }

  async pollYoutubeOnce() {
    if (!this.isConfigured("youtube")) return { checked: 0 };
    if (this.youtubePoll) return this.youtubePoll;
    const controller = new AbortController();
    this.youtubePollAbort = controller;
    /** @type {typeof fetch} */
    const pollFetch = (url, init = {}) => this.fetchImpl(url, {
      ...init,
      signal: AbortSignal.any([
        ...((init.signal ? [init.signal] : [])),
        controller.signal,
      ]),
    });
    this.youtubePoll = this._pollYoutubeAll(pollFetch, controller.signal);
    try {
      return await this.youtubePoll;
    } finally {
      this.youtubePoll = null;
      if (this.youtubePollAbort === controller) this.youtubePollAbort = null;
    }
  }

  /** @param {typeof fetch} [fetchImpl] @param {AbortSignal|null} [signal] */
  async _pollYoutubeAll(fetchImpl = this.fetchImpl, signal = null) {
    const vault = this._vault();
    const rows = await vault.listConnections("youtube");
    let checked = 0;
    for (const row of rows) {
      if (signal?.aborted) break;
      checked += 1;
      try {
        await this._withConnectionLock(row.userId, "youtube", async () => {
          const current = await vault.getConnection(row.userId, "youtube");
          if (!current || current.connectionRevision !== row.connectionRevision) return;
          await this._pollYoutubeConnection({ ...current, userId: row.userId }, fetchImpl);
        });
      } catch (err) {
        if (signal?.aborted) break;
        await vault.updateMetadata(row.userId, "youtube", {
          lastError: safeMessage(err),
        }, row.connectionRevision);
        this._log("warn", { platform: "youtube", err: safeMessage(err) }, "YouTube connection poll failed");
      }
    }
    return { checked };
  }

  /** @param {Record<string, any>} row @param {typeof fetch} [fetchImpl] */
  async _pollYoutubeConnection(row, fetchImpl = this.fetchImpl) {
    if (!row?.userId || !row?.accessToken || !row?.connectionRevision) return;
    const vault = this._vault();
    const revision = row.connectionRevision;
    let accessToken = row.accessToken;
    if (row.expiresAt instanceof Date && row.expiresAt.getTime() <= this.now() + 60_000) {
      if (!row.refreshToken) throw new Error("YouTube authorization expired; reconnect YouTube");
      const refreshed = await this.oauth.refreshYoutubeToken(
        this.config.youtube,
        row.refreshToken,
        fetchImpl,
      );
      const updated = await vault.updateTokens(
        row.userId,
        "youtube",
        refreshed,
        revision,
      );
      if (!updated) return;
      accessToken = refreshed.accessToken;
    }
    const items = await this.oauth.listYoutubeRecentSubscribers(accessToken, fetchImpl);
    if (!await vault.isConnectionCurrent(row.userId, "youtube", revision)) return;
    const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
    const ids = items.map((/** @type {any} */ item) => String(item?.id || "")).filter(Boolean);
    if (metadata.youtubeInitialized !== true) {
      await vault.updateMetadata(row.userId, "youtube", {
        youtubeInitialized: true,
        youtubeSeenIds: ids.slice(0, 200),
        youtubeCursorAtMs: this.now(),
        lastSyncedAt: new Date(this.now()),
        lastError: null,
      }, revision);
      return;
    }
    const seen = new Set(
      Array.isArray(metadata.youtubeSeenIds)
        ? metadata.youtubeSeenIds.map(String)
        : [],
    );
    const cursor = Number(metadata.youtubeCursorAtMs) || 0;
    const normalized = items
      .map((/** @type {any} */ item) => this.webhooks.normalizeYoutubeSubscriber(item))
      .filter(Boolean)
      .filter((/** @type {any} */ event) => !seen.has(String(event.id).replace(/^subscriber:/, "")))
      .sort((/** @type {any} */ a, /** @type {any} */ b) => a.atMs - b.atMs);
    for (const event of normalized) {
      if (!await vault.isConnectionCurrent(row.userId, "youtube", revision)) return;
      await this.events.publish(row.userId, event);
    }
    await vault.updateMetadata(row.userId, "youtube", {
      youtubeSeenIds: Array.from(new Set([...ids, ...seen])).slice(0, 200),
      youtubeCursorAtMs: Math.max(cursor, this.now()),
      lastSyncedAt: new Date(this.now()),
      lastError: null,
    }, revision);
  }

  /** Reconcile provider-managed webhook subscriptions and expiring Kick grants. */
  async reconcileProviderHealthOnce() {
    if (!this.isConfigured("twitch") && !this.isConfigured("kick")) {
      return { checked: 0 };
    }
    if (this.healthPoll) return this.healthPoll;
    const controller = new AbortController();
    this.healthPollAbort = controller;
    /** @type {typeof fetch} */
    const healthFetch = (url, init = {}) => this.fetchImpl(url, {
      ...init,
      signal: AbortSignal.any([
        ...((init.signal ? [init.signal] : [])),
        controller.signal,
      ]),
    });
    this.healthPoll = this._reconcileProviderHealthAll(
      healthFetch,
      controller.signal,
    );
    try {
      return await this.healthPoll;
    } finally {
      this.healthPoll = null;
      if (this.healthPollAbort === controller) this.healthPollAbort = null;
    }
  }

  /** @param {typeof fetch} fetchImpl @param {AbortSignal|null} signal */
  async _reconcileProviderHealthAll(fetchImpl, signal = null) {
    const vault = this._vault();
    let checked = 0;

    if (this.isConfigured("twitch") && !signal?.aborted) {
      const rows = await vault.listConnections("twitch");
      let appAccessToken = "";
      let appTokenError = null;
      if (rows.length > 0) {
        try {
          appAccessToken = await this.oauth.getTwitchAppToken(
            this.config.twitch,
            fetchImpl,
          );
        } catch (err) {
          appTokenError = err;
        }
      }
      for (const row of rows) {
        if (signal?.aborted) break;
        checked += 1;
        try {
          await this._withConnectionLock(row.userId, "twitch", async () => {
            const current = await vault.getConnection(row.userId, "twitch");
            if (!current || current.connectionRevision !== row.connectionRevision) return;
            const authorized = await this._ensureTwitchUserAuthorization(
              { ...current, userId: row.userId },
              fetchImpl,
            );
            if (!authorized) return;
            if (appTokenError) throw appTokenError;
            await this.oauth.reconcileTwitchEventSubscriptions({
              broadcasterUserId: authorized.platformUserId,
              appAccessToken,
              clientId: this.config.twitch.clientId,
              callbackUrl: this.config.twitch.callbackUrl,
              webhookSecret: this.config.twitch.webhookSecret,
              fetchImpl,
            });
            await vault.updateMetadata(row.userId, "twitch", {
              subscriptionsReady: true,
              lastError: null,
              lastSyncedAt: new Date(this.now()),
            }, row.connectionRevision);
          });
        } catch (err) {
          if (signal?.aborted) break;
          if (/** @type {any} */ (err)?.discardConnection === true) {
            this.twitchValidatedRevisions.delete(row.connectionRevision);
            await vault.disconnect(row.userId, "twitch", row.connectionRevision);
            this._log(
              "warn",
              { platform: "twitch", err: safeMessage(err) },
              "Twitch authorization became invalid and was disconnected",
            );
            continue;
          }
          await vault.updateMetadata(row.userId, "twitch", {
            subscriptionsReady: false,
            lastError: safeMessage(err),
          }, row.connectionRevision);
          this._log("warn", { platform: "twitch", err: safeMessage(err) }, "Twitch subscription reconcile failed");
        }
      }
    }

    if (this.isConfigured("kick") && !signal?.aborted) {
      const rows = await vault.listConnections("kick");
      for (const row of rows) {
        if (signal?.aborted) break;
        checked += 1;
        try {
          await this._withConnectionLock(row.userId, "kick", async () => {
            const current = await vault.getConnection(row.userId, "kick");
            if (!current || current.connectionRevision !== row.connectionRevision) return;
            let accessToken = current.accessToken;
            if (current.expiresAt instanceof Date
              && current.expiresAt.getTime() <= this.now() + 60_000) {
              if (!current.refreshToken) {
                throw new Error("Kick authorization expired; reconnect Kick");
              }
              const refreshed = await this.oauth.refreshKickToken(
                this.config.kick,
                current.refreshToken,
                fetchImpl,
              );
              const updated = await vault.updateTokens(
                row.userId,
                "kick",
                refreshed,
                row.connectionRevision,
              );
              if (!updated) return;
              accessToken = refreshed.accessToken;
            }
            await this.oauth.subscribeKickEvents(accessToken, fetchImpl);
            await vault.updateMetadata(row.userId, "kick", {
              subscriptionsReady: true,
              lastError: null,
              lastSyncedAt: new Date(this.now()),
            }, row.connectionRevision);
          });
        } catch (err) {
          if (signal?.aborted) break;
          await vault.updateMetadata(row.userId, "kick", {
            subscriptionsReady: false,
            lastError: safeMessage(err),
          }, row.connectionRevision);
          this._log("warn", { platform: "kick", err: safeMessage(err) }, "Kick subscription reconcile failed");
        }
      }
    }
    return { checked };
  }

  /**
   * Validate one stored Twitch user token at startup/hourly. A 401 receives
   * one reactive refresh; definitive invalid-grant/identity failures discard
   * only the matching connection revision so a concurrent reconnect is safe.
   * @param {Record<string, any>} row
   * @param {typeof fetch} fetchImpl
   */
  async _ensureTwitchUserAuthorization(row, fetchImpl) {
    const vault = this._vault();
    const revision = String(row.connectionRevision || "");
    const metadata = row.metadata && typeof row.metadata === "object"
      ? row.metadata
      : {};
    const lastValidatedAt = metadata.lastTokenValidatedAt instanceof Date
      ? metadata.lastTokenValidatedAt.getTime()
      : Date.parse(String(metadata.lastTokenValidatedAt || ""));
    const mustValidate = !this.twitchValidatedRevisions.has(revision)
      || !Number.isFinite(lastValidatedAt)
      || lastValidatedAt <= this.now() - TWITCH_TOKEN_VALIDATION_INTERVAL_MS;

    if (!mustValidate) {
      assertTwitchRequiredScopes(row.scopes, this.oauth.TWITCH_SCOPES);
      return row;
    }

    let accessToken = row.accessToken;
    let refreshToken = row.refreshToken;
    let expiresAt = row.expiresAt;
    let identity;
    try {
      identity = await this.oauth.validateTwitchUserToken(accessToken, fetchImpl);
    } catch (err) {
      if (!providerStatusIs(err, 401)) throw err;
      if (!refreshToken) {
        throw twitchReconnectRequired("Twitch authorization expired. Reconnect Twitch to restore notifications.");
      }
      let refreshed;
      try {
        refreshed = await this.oauth.refreshTwitchToken(
          this.config.twitch,
          refreshToken,
          fetchImpl,
        );
      } catch (refreshErr) {
        if (providerStatusIs(refreshErr, 400, 401)) {
          throw twitchReconnectRequired("Twitch authorization expired. Reconnect Twitch to restore notifications.");
        }
        throw refreshErr;
      }
      accessToken = refreshed.accessToken;
      refreshToken = refreshed.refreshToken || refreshToken;
      expiresAt = refreshed.expiresAt;
      const stored = await vault.updateTokens(row.userId, "twitch", {
        ...refreshed,
        refreshToken,
      }, revision);
      if (!stored) return null;
      try {
        identity = await this.oauth.validateTwitchUserToken(accessToken, fetchImpl);
      } catch (validateErr) {
        if (providerStatusIs(validateErr, 401)) {
          throw twitchReconnectRequired("Twitch rejected the refreshed authorization. Reconnect Twitch.");
        }
        throw validateErr;
      }
    }

    if (String(identity.userId || "") !== String(row.platformUserId || "")) {
      throw twitchReconnectRequired("Twitch authorization no longer belongs to the connected channel. Reconnect Twitch.");
    }
    const scopes = Array.isArray(identity.scopes) ? identity.scopes.map(String) : [];
    if (Number.isFinite(Number(identity.expiresInSeconds))) {
      expiresAt = new Date(this.now() + Number(identity.expiresInSeconds) * 1000);
    }
    // Persist the authoritative validation response under the same revision.
    // This also keeps old grants' scope lists accurate after a token refresh.
    const tokensCurrent = await vault.updateTokens(row.userId, "twitch", {
      accessToken,
      refreshToken,
      expiresAt,
      scopes,
    }, revision);
    if (!tokensCurrent) return null;
    const metadataCurrent = await vault.updateMetadata(row.userId, "twitch", {
      lastTokenValidatedAt: new Date(this.now()),
    }, revision);
    if (!metadataCurrent) return null;
    this.twitchValidatedRevisions.add(revision);
    assertTwitchRequiredScopes(scopes, this.oauth.TWITCH_SCOPES);
    return {
      ...row,
      accessToken,
      refreshToken,
      expiresAt,
      scopes,
      metadata: {
        ...metadata,
        lastTokenValidatedAt: new Date(this.now()),
      },
    };
  }

  /** @param {string} userId */
  recentEvents(userId) {
    return this.config.enabled
      ? this.events.recentForUser(userId)
      : Promise.resolve([]);
  }

  /** @param {Platform} platform @param {Record<string, any>} connection */
  async _revokeConnection(platform, connection) {
    if (platform === "twitch") {
      await this.oauth.revokeTwitchToken(
        this.config.twitch,
        connection.accessToken,
        this.fetchImpl,
      );
      return;
    }
    if (platform === "kick") {
      const tokens = Array.from(new Set([
        connection.accessToken,
        connection.refreshToken,
      ].filter(Boolean)));
      const results = await Promise.allSettled(
        tokens.map((token) => this.oauth.revokeKickToken(token, this.fetchImpl)),
      );
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
      return;
    }
    await this.oauth.revokeYoutubeToken(
      connection.refreshToken || connection.accessToken,
      this.fetchImpl,
    );
  }

  /** @param {Platform} platform */
  _requireConfigured(platform) {
    assertPlatform(platform);
    if (!this.isConfigured(platform)) {
      throw integrationError(503, "platform_not_configured", `${platformLabel(platform)} connections are not configured yet`);
    }
  }

  /** @returns {PlatformCredentialVault} */
  _vault() {
    if (!this.vault) {
      throw integrationError(503, "platform_not_configured", "Official platform connections are not configured yet");
    }
    return this.vault;
  }

  /**
   * Serialize mutations for one user's provider connection within this
   * process. Database revision checks provide the matching cross-process CAS.
   * @template T
   * @param {string} userId
   * @param {Platform} platform
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  async _withConnectionLock(userId, platform, task) {
    const key = `${userId}:${platform}`;
    const previous = this.connectionLocks.get(key) || Promise.resolve();
    const run = previous.catch(() => {}).then(task);
    const settled = run.then(() => {}, () => {});
    this.connectionLocks.set(key, settled);
    try {
      return await run;
    } finally {
      if (this.connectionLocks.get(key) === settled) {
        this.connectionLocks.delete(key);
      }
    }
  }

  /** @param {'warn'|'info'|'error'} level @param {Record<string,any>} fields @param {string} message */
  _log(level, fields, message) {
    try {
      this.logger?.[level]?.(fields, message);
    } catch {
      /* logging is non-critical */
    }
  }
}

/** @param {any} payload */
function twitchBroadcasterId(payload) {
  const condition = payload?.subscription?.condition || {};
  return String(
    condition.broadcaster_user_id
      || condition.to_broadcaster_user_id
      || payload?.event?.broadcaster_user_id
      || payload?.event?.to_broadcaster_user_id
      || "",
  );
}

/** @param {any} payload */
function kickBroadcasterId(payload) {
  return String(
    payload?.broadcaster?.user_id
      || payload?.broadcaster?.id
      || payload?.broadcaster_user_id
      || payload?.channel?.broadcaster_user_id
      || payload?.channel?.user_id
      || "",
  );
}

/** @param {Platform} platform */
function assertPlatform(platform) {
  if (!PLATFORMS.includes(platform)) {
    throw integrationError(404, "platform_not_supported", "Unsupported platform");
  }
}

/** @param {number} status @param {string} code @param {string} message */
function integrationError(status, code, message) {
  return new PlatformIntegrationError(status, code, message);
}

/** @param {Platform} platform */
function platformLabel(platform) {
  return platform === "youtube" ? "YouTube" : `${platform[0].toUpperCase()}${platform.slice(1)}`;
}

/** @param {unknown} err */
function safeMessage(err) {
  return err instanceof Error
    ? String(err.message || err.name).slice(0, 240)
    : "Notification setup failed";
}

/** @param {unknown} granted @param {unknown} required */
function assertTwitchRequiredScopes(granted, required) {
  const available = new Set(Array.isArray(granted) ? granted.map(String) : []);
  const missing = (Array.isArray(required) ? required : [])
    .map(String)
    .filter((scope) => !available.has(scope));
  if (missing.length === 0) return;
  const error = new Error(
    `Reconnect Twitch to grant notification permissions: ${missing.join(", ")}`,
  );
  Object.assign(error, { code: "twitch_scopes_missing", status: 403 });
  throw error;
}

/** @param {unknown} err @param {...number} statuses */
function providerStatusIs(err, ...statuses) {
  return statuses.includes(Number(/** @type {any} */ (err)?.status));
}

/** @param {string} message */
function twitchReconnectRequired(message) {
  const error = new Error(message);
  Object.assign(error, {
    code: "twitch_reconnect_required",
    status: 401,
    discardConnection: true,
  });
  return error;
}

module.exports = {
  PlatformIntegrationsService,
  PlatformIntegrationError,
  PLATFORMS,
  TWITCH_TOKEN_VALIDATION_INTERVAL_MS,
  twitchBroadcasterId,
  kickBroadcasterId,
};
