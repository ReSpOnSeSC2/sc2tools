"use strict";

/**
 * PulseCharacterLinkService — the global, cross-user cache of
 * SC2Pulse "same player" linkage.
 *
 * SC2Pulse unifies characters two ways:
 *   * ``account.id`` — characters on the same Battle.net account
 *     (name changes, multi-region alts of one login).
 *   * ``proId`` — community-verified pro/player identity that links
 *     characters ACROSS accounts (the revealed-barcode case), with
 *     ``proNickname`` as the name the community knows them by.
 *
 * The Opponents tab groups a user's opponent rows into one row per
 * real player using those two keys. This service owns the character →
 * ``{accountId, proId, proNickname}`` mapping, batch-fetched from
 * ``GET /group/character/full?characterId=…`` (accepts up to 500 ids
 * per request — verified live 2026-07-21; 501 ids → HTTP 400) and
 * persisted in a shared collection so the linkage for any opponent is
 * pulled from SC2Pulse once, ever, across all platform users.
 *
 * SC2Pulse is a free, single-maintainer community service, so the
 * client is deliberately gentle: linkage barely changes, so positive
 * rows live for a week; ids SC2Pulse doesn't know (deleted or never
 * ranked) are negative-cached for a day; and each ``getLinks`` call
 * spends at most ``MAX_BATCHES_PER_CALL`` upstream requests — a huge
 * opponent list warms up over a handful of visits instead of firing
 * dozens of requests at once, and the response says ``partial: true``
 * so the caller knows more will resolve later.
 *
 * Every failure path degrades to "fewer links known" — never throws
 * into a request handler.
 */

const { COLLECTIONS } = require("../config/constants");
const { stampVersion } = require("../db/schemaVersioning");

const PULSE_API_ROOT = "https://sc2pulse.nephest.com/sc2/api";
const REQUEST_TIMEOUT_MS = 8000;
// Hard upstream cap on ids per group/character/full request.
const BATCH_SIZE = 500;
// Upstream requests one getLinks call may spend. Everything beyond
// (BATCH_SIZE * MAX_BATCHES_PER_CALL) uncached ids waits for a later
// call and is reported via ``partial``.
const MAX_BATCHES_PER_CALL = 4;
// Account/pro linkage is effectively append-only; a week keeps a
// newly-revealed barcode reasonably fresh without re-crawling.
const LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Ids SC2Pulse returned nothing for — retried daily so a player who
// gets ranked (or revealed) later still shows up.
const MISS_TTL_MS = 24 * 60 * 60 * 1000;

const NOOP_LOGGER = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

/**
 * @typedef {{
 *   accountId: string | null,
 *   proId: string | null,
 *   proNickname: string | null,
 *   toonHandle?: string | null,
 * }} CharacterLink
 */

class PulseCharacterLinkService {
  /**
   * @param {import('mongodb').Collection} collection
   *        The shared ``pulse_character_links`` collection.
   * @param {{
   *   fetchImpl?: typeof fetch,
   *   now?: () => number,
   *   logger?: { warn: Function, info: Function, debug: Function },
   *   linkTtlMs?: number,
   *   missTtlMs?: number,
   *   maxBatchesPerCall?: number,
   *   userAgent?: string,
   *   baseUrl?: string,
   * }} [opts]
   */
  constructor(collection, opts = {}) {
    if (!collection) {
      throw new Error("PulseCharacterLinkService: collection required");
    }
    this.col = collection;
    this.fetchImpl = opts.fetchImpl || globalThis.fetch;
    this.now = opts.now || (() => Date.now());
    this.logger = opts.logger || NOOP_LOGGER;
    this.linkTtlMs =
      typeof opts.linkTtlMs === "number" && opts.linkTtlMs > 0
        ? opts.linkTtlMs
        : LINK_TTL_MS;
    this.missTtlMs =
      typeof opts.missTtlMs === "number" && opts.missTtlMs > 0
        ? opts.missTtlMs
        : MISS_TTL_MS;
    this.maxBatchesPerCall =
      typeof opts.maxBatchesPerCall === "number" && opts.maxBatchesPerCall > 0
        ? opts.maxBatchesPerCall
        : MAX_BATCHES_PER_CALL;
    this.userAgent =
      opts.userAgent ||
      "sc2tools.com opponent-grouping (+https://sc2tools.com)";
    this.baseUrl = (opts.baseUrl || PULSE_API_ROOT).replace(/\/+$/, "");
  }

  /**
   * Character → linkage for a set of SC2Pulse character ids. Serves
   * the persistent cache first, then spends a bounded number of
   * upstream batch requests on ids that are uncached or stale.
   *
   * ``links`` only contains characters SC2Pulse actually knows
   * (``accountId`` is always present on a hit). ``partial: true``
   * means some requested ids were left unresolved this call — either
   * the per-call upstream budget ran out or SC2Pulse was unreachable —
   * and a later call will fill them in.
   *
   * Never throws.
   *
 * @param {Array<string|number>} characterIds
   * @param {{includeIdentity?:boolean}} [opts]
   * @returns {Promise<{ links: Map<string, CharacterLink>, partial: boolean }>}
   */
  async getLinks(characterIds, opts = {}) {
    /** @type {Map<string, CharacterLink>} */
    const links = new Map();
    const ids = sanitizeIds(characterIds);
    if (ids.length === 0) return { links, partial: false };

    const cachedById = await this._readCache(ids);
    /** @type {string[]} */
    const needFetch = [];
    for (const id of ids) {
      const doc = cachedById.get(id);
      if (doc && this._isFresh(doc) && (!opts.includeIdentity || doc.toonHandle || !doc.accountId)) {
        appendLink(links, doc);
      } else {
        needFetch.push(id);
      }
    }
    if (needFetch.length === 0) return { links, partial: false };

    const budget = this.maxBatchesPerCall * BATCH_SIZE;
    const toFetch = needFetch.slice(0, budget);
    let partial = needFetch.length > budget;

    for (let i = 0; i < toFetch.length; i += BATCH_SIZE) {
      const batch = toFetch.slice(i, i + BATCH_SIZE);
      const fetched = await this._fetchBatch(batch);
      if (fetched === null) {
        // Upstream unreachable — stale-while-error: serve whatever
        // stale rows we do hold for this batch and flag partial so
        // the client knows to come back.
        partial = true;
        for (const id of batch) {
          const doc = cachedById.get(id);
          if (doc) appendLink(links, doc);
        }
        continue;
      }
      for (const doc of await this._persistBatch(batch, fetched)) {
        appendLink(links, doc);
      }
    }
    return { links, partial };
  }

  /**
   * Cached rows for a set of ids, keyed by character id. A read
   * failure degrades to an empty map — indistinguishable from a full
   * cache miss, so the live fetch still runs.
   *
   * @private
   * @param {string[]} ids
   * @returns {Promise<Map<string, any>>}
   */
  async _readCache(ids) {
    /** @type {Map<string, any>} */
    const cachedById = new Map();
    try {
      const cursor = this.col.find(
        { pulseCharacterId: { $in: ids } },
        {
          projection: {
            _id: 0,
            pulseCharacterId: 1,
            accountId: 1,
            proId: 1,
            proNickname: 1,
            toonHandle: 1,
            fetchedAt: 1,
          },
        },
      );
      for await (const doc of cursor) {
        if (typeof doc.pulseCharacterId === "string") {
          cachedById.set(doc.pulseCharacterId, doc);
        }
      }
    } catch (err) {
      this.logger.warn({ err }, "pulse_links_cache_read_failed");
    }
    return cachedById;
  }

  /**
   * Write-through one fetched batch: every requested id gets a row —
   * ids absent from the SC2Pulse response become negative rows (null
   * linkage) so the miss TTL applies to them. Returns the docs (hit
   * AND miss) for the caller's links map. A write failure is logged
   * and swallowed; the data is still served this call and refetched
   * next time.
   *
   * @private
   * @param {string[]} batch
   * @param {Map<string, CharacterLink>} fetched
   * @returns {Promise<Array<CharacterLink & {pulseCharacterId: string, fetchedAt: Date}>>}
   */
  async _persistBatch(batch, fetched) {
    const writeAt = new Date(this.now());
    /** @type {Array<CharacterLink & {pulseCharacterId: string, fetchedAt: Date}>} */
    const docs = [];
    /** @type {import('mongodb').AnyBulkWriteOperation[]} */
    const writes = [];
    for (const id of batch) {
      const entry = fetched.get(id) || null;
      const doc = {
        pulseCharacterId: id,
        accountId: entry ? entry.accountId : null,
        proId: entry ? entry.proId : null,
        proNickname: entry ? entry.proNickname : null,
        toonHandle: entry?.toonHandle || null,
        fetchedAt: writeAt,
      };
      docs.push(doc);
      writes.push({
        updateOne: {
          filter: { pulseCharacterId: id },
          update: {
            $setOnInsert: stampVersion(
              { pulseCharacterId: id },
              COLLECTIONS.PULSE_CHARACTER_LINKS,
            ),
            $set: {
              accountId: doc.accountId,
              proId: doc.proId,
              proNickname: doc.proNickname,
              toonHandle: doc.toonHandle,
              fetchedAt: writeAt,
              updatedAt: writeAt,
            },
          },
          upsert: true,
        },
      });
    }
    if (writes.length > 0) {
      try {
        await this.col.bulkWrite(writes, { ordered: false });
      } catch (err) {
        this.logger.warn(
          { err, count: writes.length },
          "pulse_links_cache_write_failed",
        );
      }
    }
    return docs;
  }

  /**
   * @private
   * @param {{ accountId?: unknown, fetchedAt?: unknown }} doc
   * @returns {boolean}
   */
  _isFresh(doc) {
    const fetchedAt =
      doc.fetchedAt instanceof Date ? doc.fetchedAt.getTime() : null;
    if (fetchedAt === null) return false;
    const ttl = doc.accountId ? this.linkTtlMs : this.missTtlMs;
    return this.now() - fetchedAt < ttl;
  }

  /**
   * One ``group/character/full`` round-trip. Returns a map of the
   * characters SC2Pulse knows from this batch (ids absent from the
   * result are negative — deleted or never ranked), or null when the
   * request failed outright.
   *
   * @private
   * @param {string[]} batch
   * @returns {Promise<Map<string, CharacterLink> | null>}
   */
  async _fetchBatch(batch) {
    if (!this.fetchImpl) return null;
    const url =
      `${this.baseUrl}/group/character/full` +
      `?characterId=${batch.join(",")}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    if (typeof timer.unref === "function") timer.unref();
    let payload;
    try {
      const res = await this.fetchImpl(url, {
        headers: {
          accept: "application/json",
          "user-agent": this.userAgent,
        },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`pulse_http_${res.status}`);
      const text = await res.text();
      // SC2Pulse answers an all-unknown batch with an empty body.
      payload = text ? JSON.parse(text) : [];
    } catch (err) {
      this.logger.warn(
        { err: String(err), count: batch.length },
        "pulse_links_fetch_failed",
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
    /** @type {Map<string, CharacterLink>} */
    const out = new Map();
    if (!Array.isArray(payload)) return out;
    for (const entry of payload) {
      const members = entry && entry.members;
      const ch = members && members.character;
      if (!ch || ch.id === undefined || ch.id === null) continue;
      const id = String(ch.id);
      const account = members.account;
      const accountId =
        account && account.id !== undefined && account.id !== null
          ? String(account.id)
          : null;
      const proId =
        members.proId !== undefined && members.proId !== null
          ? String(members.proId)
          : null;
      const proNickname =
        typeof members.proNickname === "string" && members.proNickname
          ? members.proNickname
          : null;
      const region = /** @type {Record<string,string>} */ ({ US: "1", NA: "1", EU: "2", KR: "3", CN: "5", SEA: "6" })[String(ch.region).toUpperCase()];
      const toonHandle = region && /^\d+$/.test(String(ch.realm)) && /^\d+$/.test(String(ch.battlenetId))
        ? `${region}-S2-${ch.realm}-${ch.battlenetId}` : null;
      out.set(id, { accountId, proId, proNickname, toonHandle });
    }
    return out;
  }
}

/**
 * Numeric-string ids only, deduped, order preserved. Anything else
 * (toon handles, empty strings) is silently dropped — those opponents
 * simply stay ungrouped.
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
function sanitizeIds(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  for (const v of raw) {
    const id = String(v === undefined || v === null ? "" : v).trim();
    if (!/^\d+$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Add a cache/fetch doc to the outgoing links map — hits only.
 * Negative rows (no accountId) carry no grouping signal and are
 * omitted so the payload stays proportional to what's linkable.
 *
 * @param {Map<string, CharacterLink>} links
 * @param {{
 *   pulseCharacterId: string,
 *   accountId?: unknown,
 *   proId?: unknown,
 *   proNickname?: unknown,
 * }} doc
 */
function appendLink(links, doc) {
  const accountId =
    typeof doc.accountId === "string" && doc.accountId ? doc.accountId : null;
  const proId = typeof doc.proId === "string" && doc.proId ? doc.proId : null;
  if (!accountId && !proId) return;
  links.set(doc.pulseCharacterId, {
    accountId,
    proId,
    proNickname:
      typeof doc.proNickname === "string" && doc.proNickname
        ? doc.proNickname
        : null,
  });
}

module.exports = {
  PulseCharacterLinkService,
  __internal: { sanitizeIds, BATCH_SIZE, LINK_TTL_MS, MISS_TTL_MS },
};
