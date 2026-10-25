"use strict";

const { randomUUID } = require("crypto");
const { accountMatchHandles } = require("../util/accountFilter");
const { STATS_GAME_MATCH, OwnerRevisions } = require("../util/gameVisibility");
const { startSeries, readSeries, scoreSeriesGame, editSeries, publicSeries, seriesError } = require("./streamSeriesModel");
const UNAVAILABLE = ["overlay_rotation_pending", "overlay_token_resolve_busy", "invalid_overlay_token"];
const H2H_TTL_MS = 60_000;

/** Explicit token-owned Series state lives inside the existing canonical
 * Studio document. Rotation, deletion and inventory already carry that row.
 * No background scan, collection, index, provider request or ordinary idle
 * write is needed. All mutations join the existing token rotation drain. */
class StreamSeriesService {
  /** @param {{studio:import('./multichatStudio').MultichatStudioService,games:import('mongodb').Collection,
   * tokens:Pick<import('./overlayTokens').OverlayTokensService,'withWrite'|'resolve'|'list'>,
   * io?:import('socket.io').Server,now?:()=>number,
   * onCompleted?:(token:string,series:NonNullable<ReturnType<typeof publicSeries>>)=>Promise<void>}} deps */
  constructor(deps) {
    this.studio = deps.studio; this.games = deps.games; this.tokens = deps.tokens;
    this.io = deps.io; this.now = deps.now || Date.now; this.onCompleted = deps.onCompleted;
    /** @type {Map<string,{owner:string,until:number,value:{wins:number,losses:number,draws:number,asOf:number}}>} */
    this.h2h = new Map();
    this.owners = new OwnerRevisions();
  }

  /** @param {string} owner */
  invalidateForUser(owner) {
    this.owners.invalidate(owner);
    for (const [key, value] of this.h2h) if (value.owner === owner) this.h2h.delete(key);
  }

  /** @param {string} token @param {string} owner */
  async _checkOwner(token, owner) {
    if ((await this.tokens.resolve(token))?.userId !== owner) throw seriesError(401, "invalid_overlay_token");
  }

  /** Read-only bootstrap; an absent series does not mint a Studio document.
   * @param {string} token @param {string} owner */
  async get(token, owner) {
    await this._checkOwner(token, owner);
    const row = await this.studio._findDocument(token, { projection: { streamSeries: 1 } });
    const snapshot = await this.snapshot(owner, readSeries(row?.streamSeries));
    // H2H/Mongo may have been held while this bearer was rotated/revoked.
    // Both HTTP and socket bootstrap use this same final ownership fence.
    await this._checkOwner(token, owner);
    return snapshot;
  }

  /** Shared Chat v2 composer: one projected local read, no H2H aggregate or
   * provider lookup. The registry owns aliases, enablement and cooldowns.
   * @param {string} token @param {string} owner */
  async chatLine(token, owner) {
    await this._checkOwner(token, owner);
    const row = await this.studio._findDocument(token, { projection: { streamSeries: 1 } });
    const series = publicSeries(readSeries(row?.streamSeries));
    await this._checkOwner(token, owner);
    if (!series) return "No series has been started in this Dock.";
    const status = series.status === "complete" ? series.score.you > series.score.opponent ? ", series won" : ", series lost"
      : series.status === "ended" ? ", ended" : series.status === "paused" ? ", automatic scoring paused" : "";
    const next = ["active", "paused"].includes(series.status) && series.currentMap ? `, next map ${series.currentMap}` : "";
    return `Bo${series.format} vs ${series.opponentName}: ${series.score.you}–${series.score.opponent}${next}${status}.`;
  }

  /** @param {string} owner @param {ReturnType<typeof readSeries>} stored */
  async snapshot(owner, stored) {
    const series = publicSeries(stored);
    if (!series) return null;
    return { ...series, headToHead: stored?.opponentToon ? await this.headToHead(owner, stored.opponentToon) : null };
  }

  /** One bounded cached local aggregate for an exact identity; a typed name
   * never guesses another account's lifetime history. Failure stays unknown.
   * @param {string} owner @param {string} opponentToon */
  async headToHead(owner, opponentToon) {
    const key = `${owner}:${opponentToon}`, now = this.now();
    const cached = this.h2h.get(key);
    if (cached && cached.until > now) return cached.value;
    const epoch = this.owners.get(owner);
    try {
      const rows = await this.games.aggregate([
        { $match: { userId: owner, ...STATS_GAME_MATCH, isResumedFromReplay: { $ne: true }, "opponent.toonHandle": { $in: accountMatchHandles([opponentToon]) } } },
        { $group: { _id: null,
          wins: { $sum: { $cond: [{ $in: [{ $toLower: "$result" }, ["win", "victory"]] }, 1, 0] } },
          losses: { $sum: { $cond: [{ $in: [{ $toLower: "$result" }, ["loss", "defeat"]] }, 1, 0] } },
          draws: { $sum: { $cond: [{ $in: [{ $toLower: "$result" }, ["tie", "draw"]] }, 1, 0] } } } },
      ], { maxTimeMS: 1000 }).toArray();
      const value = { wins: Number(rows[0]?.wins) || 0, losses: Number(rows[0]?.losses) || 0,
        draws: Number(rows[0]?.draws) || 0, asOf: now };
      // A lifecycle change while Mongo was held must not refill a stale cache.
      if (!this.owners.current(owner, epoch)) return null;
      for (const [old, entry] of this.h2h) if (entry.until <= now) this.h2h.delete(old);
      if (this.h2h.size >= 256) this.h2h.delete(this.h2h.keys().next().value || "");
      this.h2h.set(key, { owner, until: now + H2H_TTL_MS, value });
      return value;
    } catch { return null; }
  }

  /** Only explicit Start/End/±1 actions can change control state.
   * @param {string} token @param {string} owner @param {Record<string,any>} body */
  async act(token, owner, body) {
    return this.tokens.withWrite(token, async () => {
      await this._checkOwner(token, owner);
      if (!body || typeof body !== "object" || Array.isArray(body) || !Number.isSafeInteger(body.revision)
        || body.revision < 0) throw seriesError(400, "invalid_series_action");
      const row = await this.studio.ensureCanonical(token);
      const current = readSeries(row.streamSeries);
      if ((current?.revision ?? 0) !== body.revision) throw seriesError(409, "series_changed");
      const next = body.action === "start" ? startSeries(body, this.now(), randomUUID(), body.revision + 1)
        : current ? editSeries(current, body, this.now()) : null;
      if (!next) throw seriesError(409, "series_not_started");
      return this.commit(token, owner, row.streamSeries, next);
    });
  }

  /** Never overwrite another Dock's start or an ingest/manual correction.
   * The filter covers only Series; concurrent unrelated Studio edits survive.
   * @param {string} token @param {string} owner @param {unknown} previousRaw
   * @param {NonNullable<ReturnType<typeof readSeries>>} next */
  async commit(token, owner, previousRaw, next) {
    const completed = next.status === "complete" && !next.completionNotified;
    if (completed) next = { ...next, completionNotified: true };
    const written = await this.studio.col.updateOne({ studioKey: token,
      streamSeries: previousRaw === undefined ? { $exists: false } : { $eq: previousRaw },
    }, { $set: { streamSeries: next, updatedAt: new Date(this.now()) } });
    if (!written.matchedCount) throw seriesError(409, "series_changed");
    const dto = await this.snapshot(owner, next);
    await this._checkOwner(token, owner);
    this.io?.to(`overlay:${token}`).emit("overlay:series", dto);
    // The durable receipt makes ambiguous/retried writes unable to repeat the
    // advisory moment. Completion never reconnects or enables a provider.
    if (completed && dto) {
      try { await this.onCompleted?.(token, dto); } catch { /* moment is advisory */ }
    }
    await this._checkOwner(token, owner);
    return dto;
  }

  /** All accepted non-synthetic rows, not merely the freshest live payload,
   * pass here once. Active candidates are selected in one projected batch.
   * @param {string} owner @param {Array<Record<string,any>>} games */
  async ingest(owner, games) {
    if (!games.length) return;
    this.invalidateForUser(owner);
    const active = (await this.tokens.list(owner)).filter(t => !t.revokedAt && !("rotationPending" in t && t.rotationPending)).slice(0, 32);
    if (!active.length) return;
    const rows = await this.studio.col.find({ studioKey: { $in: active.map(t => t.token) }, "streamSeries.status": "active" },
      { projection: { _id: 0, studioKey: 1 }, maxTimeMS: 1000 }).limit(32).toArray();
    for (const row of rows) {
      const token = String(row.studioKey);
      try { await this.tokens.withWrite(token, () => this.ingestToken(token, owner, games.slice(0, 50))); }
      catch (error) { if (!UNAVAILABLE.includes(/** @type {any} */ (error)?.code)) throw error; }
    }
  }

  /** Bounded CAS retry replays the pure reducer over fresh state. Receipts
   * dedupe concurrent ingest and are retained until an explicit new Start.
   * @param {string} token @param {string} owner @param {Array<Record<string,any>>} games */
  async ingestToken(token, owner, games) {
    await this._checkOwner(token, owner);
    for (let attempt = 0; attempt < 3; attempt++) {
      const row = await this.studio.col.findOne({ studioKey: token }, { projection: { streamSeries: 1 } });
      const previous = readSeries(row?.streamSeries);
      if (!previous || previous.status !== "active") return;
      let next = previous;
      for (const game of [...games].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))) next = scoreSeriesGame(next, game, this.now()) ?? next;
      if (next === previous) return;
      try { await this.commit(token, owner, row?.streamSeries, next); return; }
      catch (error) { if (/** @type {any} */ (error)?.code !== "series_changed" || attempt === 2) throw error; }
    }
  }
}

module.exports = { StreamSeriesService };
