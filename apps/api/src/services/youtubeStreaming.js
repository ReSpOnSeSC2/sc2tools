"use strict";

// This is a narrow provider facade, never an arbitrary Google request proxy.
// OAuth grants remain in the server vault. Every write uses the exactly-once
// grant callback; ambiguous inserts are recovered through the durable ledger.
const LIFE = new Set(["created", "ready", "testing", "testStarting", "liveStarting", "live", "complete", "revoked"]);
const TERMINAL = new Set(["complete", "revoked"]);
const ORIGIN = "https://www.googleapis.com/youtube/v3/";
const PARTS = "id,snippet,status,contentDetails";

/** @param {number} status @param {string} code */
function fail(status, code) {
  return Object.assign(new Error(code), { status, code });
}

/** @param {any} value @param {number} [limit] */
function identifier(value, limit = 128) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > limit) throw fail(400, "youtube_identity_invalid");
  return value;
}

/** @param {any} value */
function ids(value) {
  if (!Array.isArray(value) || !value.length || value.length > 50) throw fail(400, "youtube_ids_invalid");
  const values = value.map((item) => identifier(item));
  if (new Set(values).size !== values.length) throw fail(400, "youtube_ids_invalid");
  return values;
}

/** @param {any} title @param {any} description */
function metadata(title, description) {
  if (typeof title !== "string" || !title.trim() || title.length > 100 || /[<>]/.test(title) || typeof description !== "string" || Buffer.byteLength(description, "utf8") > 5000 || /[<>]/.test(description)) throw fail(400, "youtube_metadata_invalid");
  return { title, description };
}

/** @param {any} value @param {number|undefined} now */
function insertBody(value, now) {
  if (!value || typeof value !== "object" || Object.keys(value).some((key) => !["snippet", "status", "contentDetails"].includes(key))) throw fail(400, "youtube_create_invalid");
  const snippet = value.snippet || {}, status = value.status || {}, details = value.contentDetails || {};
  if (Object.keys(snippet).some((key) => !["title", "description", "categoryId", "scheduledStartTime"].includes(key)) || Object.keys(status).some((key) => !["privacyStatus", "selfDeclaredMadeForKids"].includes(key)) || Object.keys(details).some((key) => !["enableAutoStart", "enableAutoStop", "monitorStream"].includes(key)) || snippet.categoryId !== undefined && snippet.categoryId !== "20") throw fail(400, "youtube_create_invalid");
  const scheduled = Date.parse(snippet.scheduledStartTime);
  // A completed old operation can still be replayed by its exact UUID. This
  // bound applies to new inserts, preventing unbounded scheduling requests.
  if (!Number.isFinite(scheduled) || now !== undefined && (scheduled < now - 15 * 60_000 || scheduled > now + 10 * 60_000) || !["private", "unlisted", "public"].includes(status.privacyStatus) || typeof status.selfDeclaredMadeForKids !== "boolean" || details.enableAutoStart !== true || details.enableAutoStop !== true || details.monitorStream?.enableMonitorStream !== false || Object.keys(details.monitorStream || {}).some((key) => key !== "enableMonitorStream")) throw fail(400, "youtube_create_invalid");
  return {
    snippet: { ...metadata(snippet.title, snippet.description), ...(snippet.categoryId ? { categoryId: snippet.categoryId } : {}), scheduledStartTime: new Date(scheduled).toISOString() },
    status: { privacyStatus: status.privacyStatus, selfDeclaredMadeForKids: status.selfDeclaredMadeForKids },
    contentDetails: { enableAutoStart: true, enableAutoStop: true, monitorStream: { enableMonitorStream: false } },
  };
}

/** @param {any} row @param {string} channel */
function safeStream(row, channel) {
  if (row?.snippet?.channelId !== channel) throw fail(409, "youtube_ownership_changed");
  if (!["active", "created", "ready", "inactive", "error"].includes(row.status?.streamStatus)) throw fail(502, "youtube_response_invalid");
  return { id: identifier(row.id), snippet: { channelId: channel, title: typeof row.snippet.title === "string" ? row.snippet.title.slice(0, 200) : "" }, status: { streamStatus: row.status.streamStatus } };
}

/** @param {any} row @param {string} channel */
function safeBroadcast(row, channel) {
  if (row?.snippet?.channelId !== channel) throw fail(409, "youtube_ownership_changed");
  if (!LIFE.has(row.status?.lifeCycleStatus) || !row.contentDetails || typeof row.contentDetails !== "object") throw fail(502, "youtube_response_invalid");
  const clean = metadata(row.snippet.title, row.snippet.description || "");
  return {
    id: identifier(row.id),
    snippet: { channelId: channel, ...clean, ...(typeof row.snippet.categoryId === "string" && /^[0-9]{1,8}$/.test(row.snippet.categoryId) ? { categoryId: row.snippet.categoryId } : {}), ...(typeof row.snippet.scheduledStartTime === "string" ? { scheduledStartTime: row.snippet.scheduledStartTime.slice(0, 64) } : {}) },
    status: { lifeCycleStatus: row.status.lifeCycleStatus, privacyStatus: row.status.privacyStatus, selfDeclaredMadeForKids: row.status.selfDeclaredMadeForKids },
    contentDetails: {
      ...(row.contentDetails.boundStreamId ? { boundStreamId: identifier(row.contentDetails.boundStreamId) } : {}),
      enableAutoStart: row.contentDetails.enableAutoStart,
      enableAutoStop: row.contentDetails.enableAutoStop,
      monitorStream: { enableMonitorStream: row.contentDetails.monitorStream?.enableMonitorStream },
    },
    ...(row.metadataPending === true ? { metadataPending: true } : {}),
  };
}

class YoutubeStreamingService {
  /** @param {{integrations:any,ledger:any,now?:()=>number}} deps */
  constructor(deps) {
    this.integrations = deps.integrations;
    this.ledger = deps.ledger;
    this.now = deps.now || Date.now;
    /** @type {Promise<void>|null} */
    this.indexesReady = null;
    /** @type {Map<string,{expires:number,value:any}>} */
    this.cache = new Map();
  }

  /** @param {string} userId @param {(grant:any)=>Promise<any>} operation */
  async _grant(userId, operation) {
    if (!userId || typeof this.integrations?.withStreamingGrant !== "function") throw fail(503, "youtube_streaming_unavailable");
    return this.integrations.withStreamingGrant(userId, "youtube", operation);
  }

  async _ready() {
    if (!this.ledger) throw fail(503, "youtube_ledger_unavailable");
    if (!this.indexesReady) this.indexesReady = this.ledger.ensureIndexes();
    try { await this.indexesReady; } catch { this.indexesReady = null; throw fail(503, "youtube_ledger_unavailable"); }
  }

  /** @param {string} userId @param {any} grant @param {any} row */
  async _safeOwnedRead(userId, grant, row) {
    const safe = safeBroadcast(row, grant.platformUserId);
    if (safe.snippet.description.includes("[SC2Tools: ") && this.ledger) {
      const owned = await this.ledger.getOwnedBroadcast({ userId, broadcastId: safe.id, expectedChannelId: grant.platformUserId });
      if (owned) return safeBroadcast(await this.ledger.sanitizeOwnedBroadcast({ userId, expectedChannelId: grant.platformUserId, broadcast: safe }), grant.platformUserId);
    }
    return safe;
  }

  /** @param {any} grant @param {string} expected */
  _channel(grant, expected) {
    const channel = identifier(grant.platformUserId);
    if (expected !== channel) throw fail(409, "youtube_ownership_changed");
    return channel;
  }

  /** @param {any} grant @param {string} resource @param {Record<string,string>} params @param {any} [body] @param {string} [method] */
  async _request(grant, resource, params, body, method = "GET") {
    if (!["channels", "liveStreams", "liveBroadcasts", "liveBroadcasts/bind", "videos"].includes(resource)) throw fail(400, "youtube_operation_invalid");
    await grant.assertCurrent();
    const url = new URL(resource, ORIGIN);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const response = await grant.boundedFetch(url.toString(), {
      method, redirect: "error",
      headers: { Authorization: "Bearer " + grant.accessToken, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      let quota = response.status === 429;
      if (response.status === 403) {
        // Inspect only Google's documented quota reasons, never forward the
        // private response body or its message/URL/account metadata.
        const errorText = await response.text();
        if (errorText.length <= 65_536) {
          try {
            const errors = JSON.parse(errorText)?.error?.errors;
            quota = Array.isArray(errors) && errors.some((item) => ["quotaExceeded", "dailyLimitExceeded", "rateLimitExceeded", "userRateLimitExceeded"].includes(item?.reason));
          } catch { /* malformed private error remains a generic rejection */ }
        }
      }
      throw fail(quota ? 429 : response.status === 401 || response.status === 403 ? 403 : 502, quota ? "youtube_quota_limited" : "youtube_provider_unavailable");
    }
    const text = await response.text();
    if (text.length > 1024 * 1024) throw fail(502, "youtube_response_invalid");
    let result;
    try { result = JSON.parse(text); } catch { throw fail(502, "youtube_response_invalid"); }
    if (!result || typeof result !== "object" || Array.isArray(result)) throw fail(502, "youtube_response_invalid");
    await grant.assertCurrent();
    return result;
  }

  /** @param {any} grant @param {string} resource @param {Record<string,string>} params @returns {Promise<any[]>} */
  async _list(grant, resource, params) {
    const rows = [], seen = new Set();
    let pageToken = "";
    for (let page = 0; page < 4; page += 1) {
      const response = await this._request(grant, resource, { ...params, maxResults: "50", ...(pageToken ? { pageToken } : {}) });
      if (!Array.isArray(response.items) || response.items.length > 50) throw fail(502, "youtube_response_invalid");
      for (const row of response.items) {
        if (!row?.id || seen.has(row.id)) throw fail(502, "youtube_inventory_unknown");
        seen.add(row.id);
        rows.push(row);
      }
      if (!response.nextPageToken) return rows;
      if (typeof response.nextPageToken !== "string" || response.nextPageToken.length > 2048) throw fail(502, "youtube_inventory_unknown");
      pageToken = response.nextPageToken;
    }
    throw fail(409, "youtube_inventory_unknown");
  }

  /** @param {string} userId @param {any} grant @param {string} label @param {number} ttl @param {()=>Promise<any>} read */
  async _cached(userId, grant, label, ttl, read) {
    const key = JSON.stringify([userId, grant.platformUserId, grant.connectionRevision, label]);
    const cached = this.cache.get(key);
    if (cached && cached.expires > this.now()) return structuredClone(cached.value);
    const value = await read();
    this.cache.set(key, { value: structuredClone(value), expires: this.now() + ttl });
    while (this.cache.size > 512) this.cache.delete(this.cache.keys().next().value || "");
    return value;
  }

  /** @param {string} userId */
  _invalidate(userId) {
    for (const key of this.cache.keys()) if (JSON.parse(key)[0] === userId) this.cache.delete(key);
  }

  /** @param {string} userId @param {any} grant @returns {Promise<any[]>} */
  async _reusable(userId, grant) {
    return this._cached(userId, grant, "reusable", 30_000, async () => {
      // The official mine=true liveStreams filter excludes non-reusable
      // streams; liveStreams.list does not accept contentDetails in part.
      const rows = await this._list(grant, "liveStreams", { part: "id,snippet,cdn,status", mine: "true" });
      return rows.filter((row) => row.contentDetails?.isReusable !== false).map((row) => safeStream(row, grant.platformUserId));
    });
  }

  /** @param {string} userId */
  async catalog(userId) {
    return this._grant(userId, async (grant) => ({
      channel: { id: identifier(grant.platformUserId), title: String(grant.platformUserName || "YouTube") },
      streams: (await this._reusable(userId, grant)).map((row) => ({ id: row.id, title: row.snippet.title, channel: row.snippet.channelId })),
    }));
  }

  /** @param {string} userId @param {any} grant @param {string[]} values @returns {Promise<any[]>} */
  async _broadcasts(userId, grant, values) {
    const requested = ids(values);
    const rows = await this._list(grant, "liveBroadcasts", { part: PARTS, id: requested.join(",") });
    if (rows.length !== requested.length || rows.some((row) => !requested.includes(row.id))) throw fail(409, "youtube_ownership_changed");
    const byId = new Map();
    for (const row of rows) byId.set(row.id, await this._safeOwnedRead(userId, grant, row));
    return requested.map((id) => byId.get(id));
  }

  /** @param {string} userId @param {any} grant */
  async _occupied(userId, grant) {
    const byId = new Map();
    for (const broadcastStatus of ["active", "upcoming"]) {
      for (const row of await this._list(grant, "liveBroadcasts", { part: PARTS, broadcastStatus })) {
        const safe = await this._safeOwnedRead(userId, grant, row);
        if (byId.has(safe.id) && JSON.stringify(byId.get(safe.id)) !== JSON.stringify(safe)) throw fail(409, "youtube_inventory_unknown");
        byId.set(safe.id, safe);
      }
    }
    return Array.from(byId.values());
  }

  /** @param {string} userId @param {string} operation @param {any} args */
  async read(userId, operation, args = {}) {
    return this._grant(userId, async (grant) => {
      if (operation === "recover_create") return this._recover(userId, grant, args.operation_id);
      if (operation === "streams_by_ids") {
        const requested = ids(args.ids);
        const rows = await this._list(grant, "liveStreams", { part: "id,snippet,cdn,status", id: requested.join(",") });
        if (rows.length !== requested.length || rows.some((row) => !requested.includes(row.id))) throw fail(409, "youtube_ownership_changed");
        return { items: rows.map((row) => safeStream(row, grant.platformUserId)) };
      }
      if (operation === "broadcasts_by_ids") return { items: await this._broadcasts(userId, grant, args.ids) };
      if (operation === "all_owned_broadcasts") {
        const rows = await this._list(grant, "liveBroadcasts", { part: PARTS, mine: "true" });
        const items = [];
        for (const row of rows) items.push(await this._safeOwnedRead(userId, grant, row));
        return { items };
      }
      if (operation === "occupied_broadcasts") return { items: await this._occupied(userId, grant) };
      throw fail(400, "youtube_operation_invalid");
    });
  }

  /** @param {string} userId @param {any} grant @param {string} operationId */
  async _recover(userId, grant, operationId) {
    if (!this.ledger) throw fail(503, "youtube_ledger_unavailable");
    const result = await this.ledger.reconcile({ userId, operationId, expectedChannelId: grant.platformUserId }, async () => {
      return (await this._list(grant, "liveBroadcasts", { part: PARTS, mine: "true" })).map((row) => safeBroadcast(row, grant.platformUserId));
    });
    if (!result || result.phase !== "succeeded" || !result.broadcast) throw fail(409, "creation_uncertain");
    // Ledger proof permits removing its own exact marker from this response.
    // It does not edit the cloud on a read request or normalize foreign rows.
    return safeBroadcast(result.broadcast, grant.platformUserId);
  }

  /** @param {string} userId @param {any} payload */
  async create(userId, payload) {
    await this._ready();
    return this._grant(userId, async (grant) => {
      const channel = this._channel(grant, payload.expected_channel_id);
      const intent = insertBody(payload.body, undefined);
      const args = { userId, operationId: payload.operation_id, intent, expectedChannelId: channel };
      if (!await this.ledger.inspect(args)) insertBody(payload.body, this.now());
      const result = await this.ledger.execute(args, /** @param {any} context */ async (context) => {
        const body = structuredClone(intent);
        body.snippet.description += context.marker;
        metadata(body.snippet.title, body.snippet.description);
        const row = safeBroadcast(await this._request(grant, "liveBroadcasts", { part: PARTS }, body, "POST"), channel);
        await grant.assertCurrent();
        return row;
      });
      if (result.phase !== "succeeded" || !result.broadcast) throw fail(409, "creation_uncertain");
      this._invalidate(userId);
      let row = safeBroadcast(result.broadcast, channel);
      {
        // The owned ID is durable before this idempotent metadata cleanup.
        // Failure still returns the confirmed ID so normal metadata recovery
        // can proceed without repeating the non-idempotent insert.
        try { row = await this._updateMetadata(userId, grant, row.id, intent.snippet.title, intent.snippet.description); } catch { row.metadataPending = true; }
      }
      return row;
    });
  }

  /** @param {string} userId @param {any} grant @param {string} broadcastId */
  async _owned(userId, grant, broadcastId) {
    const owned = await this.ledger?.getOwnedBroadcast({ userId, broadcastId: identifier(broadcastId), expectedChannelId: grant.platformUserId });
    if (!owned) throw fail(409, "youtube_ownership_changed");
    return owned;
  }

  /** @param {string} userId @param {any} payload */
  async bind(userId, payload) {
    await this._ready();
    return this._grant(userId, async (grant) => {
      this._channel(grant, payload.expected_channel_id);
      const owned = await this._owned(userId, grant, payload.broadcast_id);
      const streamId = identifier(payload.stream_id);
      if ((owned.selectedStreamId || owned.contentDetails?.boundStreamId) && (owned.selectedStreamId || owned.contentDetails.boundStreamId) !== streamId) throw fail(409, "youtube_ownership_changed");
      const current = (await this._broadcasts(userId, grant, [payload.broadcast_id]))[0];
      if (current.contentDetails.boundStreamId && current.contentDetails.boundStreamId !== streamId || TERMINAL.has(current.status.lifeCycleStatus)) throw fail(409, "youtube_ownership_changed");
      if (!(await this._reusable(userId, grant)).some((row) => row.id === streamId)) throw fail(409, "youtube_stream_not_reusable");
      if ((await this._occupied(userId, grant)).some((row) => row.id !== current.id && row.contentDetails.boundStreamId === streamId && !TERMINAL.has(row.status.lifeCycleStatus))) throw fail(409, "youtube_foreign_event_conflict");
      const streams = await this._list(grant, "liveStreams", { part: "id,snippet,cdn,status", id: streamId });
      if (streams.length !== 1 || streams[0].id !== streamId) throw fail(409, "youtube_ownership_changed");
      if (!["created", "ready", "inactive"].includes(safeStream(streams[0], grant.platformUserId).status.streamStatus)) throw fail(409, "cloud_ingest_active");
      await grant.assertCurrent();
      await this.ledger.claimStream({ userId, broadcastId: current.id, expectedChannelId: grant.platformUserId, streamId }, /** @param {string} previousId */ async (previousId) => {
        const previous = (await this._broadcasts(userId, grant, [previousId]))[0];
        return TERMINAL.has(previous.status.lifeCycleStatus);
      });
      await this.ledger.markBound({ userId, broadcastId: current.id, expectedChannelId: grant.platformUserId, streamId });
      const row = current.contentDetails.boundStreamId === streamId ? current : await this._safeOwnedRead(userId, grant, await this._request(grant, "liveBroadcasts/bind", { id: current.id, streamId, part: PARTS }, undefined, "POST"));
      if (row.id !== current.id || row.contentDetails.boundStreamId !== streamId) throw fail(409, "binding_uncertain");
      await grant.assertCurrent();
      await this.ledger.markBound({ userId, broadcastId: row.id, expectedChannelId: grant.platformUserId, streamId, broadcast: row });
      this._invalidate(userId);
      return row;
    });
  }

  /** @param {string} userId @param {any} grant @param {string} broadcastId @param {string} title @param {string} description */
  async _updateMetadata(userId, grant, broadcastId, title, description) {
    const wanted = metadata(title, description);
    const response = await this._request(grant, "videos", { part: "snippet", id: broadcastId });
    const video = response.items?.[0];
    if (response.items?.length !== 1 || video?.id !== broadcastId || video.snippet?.channelId !== grant.platformUserId || !video.snippet?.categoryId) throw fail(409, "youtube_ownership_changed");
    const snippet = { categoryId: video.snippet.categoryId, ...wanted };
    if (typeof snippet.categoryId !== "string" || !/^[0-9]{1,8}$/.test(snippet.categoryId)) throw fail(502, "youtube_metadata_unverified");
    for (const key of ["tags", "defaultLanguage", "defaultAudioLanguage"]) if (Object.hasOwn(video.snippet, key)) Object.assign(snippet, { [key]: video.snippet[key] });
    if (Object.hasOwn(video.snippet, "tags") && (!Array.isArray(video.snippet.tags) || video.snippet.tags.length > 500 || /** @type {unknown[]} */ (video.snippet.tags).some((tag) => typeof tag !== "string" || tag.length > 500)) || ["defaultLanguage", "defaultAudioLanguage"].some((key) => Object.hasOwn(video.snippet, key) && (typeof video.snippet[key] !== "string" || video.snippet[key].length > 64))) throw fail(502, "youtube_metadata_unverified");
    if (video.snippet.title !== title || (video.snippet.description || "") !== description) {
      const updated = await this._request(grant, "videos", { part: "snippet" }, { id: broadcastId, snippet }, "PUT");
      if (updated.id !== broadcastId || updated.snippet?.channelId !== grant.platformUserId || updated.snippet?.title !== title || updated.snippet?.description !== description) throw fail(502, "youtube_metadata_unverified");
      for (const key of ["categoryId", "tags", "defaultLanguage", "defaultAudioLanguage"]) {
        if (Object.hasOwn(snippet, key) && JSON.stringify(updated.snippet[key]) !== JSON.stringify(/** @type {any} */ (snippet)[key])) throw fail(502, "youtube_metadata_unverified");
      }
    }
    const verified = (await this._broadcasts(userId, grant, [broadcastId]))[0];
    if (verified.snippet.title !== title || verified.snippet.description !== description || verified.metadataPending) throw fail(502, "youtube_metadata_unverified");
    return verified;
  }

  /** @param {string} userId @param {any} payload */
  async updateMetadata(userId, payload) {
    await this._ready();
    return this._grant(userId, async (grant) => {
      this._channel(grant, payload.expected_channel_id);
      const wanted = metadata(payload.title, payload.description);
      const owned = await this._owned(userId, grant, payload.broadcast_id);
      const current = (await this._broadcasts(userId, grant, [payload.broadcast_id]))[0];
      const pinned = owned.selectedStreamId || owned.contentDetails?.boundStreamId;
      if (TERMINAL.has(current.status.lifeCycleStatus) || pinned && pinned !== current.contentDetails.boundStreamId) throw fail(409, "youtube_ownership_changed");
      const row = await this._updateMetadata(userId, grant, current.id, wanted.title, wanted.description);
      this._invalidate(userId);
      return row;
    });
  }
}

module.exports = { YoutubeStreamingService, safeBroadcast, safeStream, insertBody, fail };
