"use strict";

const query = require("./privateSearchQuery");
const { decodeCandidates, serializeResponse, unavailable } = require("./privateSearchDecode");
const { readPrivateFacet } = require("./privateSearchReader");
const { PrivateSearchCapacity } = require("./privateSearchCapacity");
const { PrivateSearchIdentity } = require("./privateSearchIdentity");
const { validId } = require("./privateSearchText");
const { PRIVATE_SEARCH_OPPONENT_INDEX } = require("../db/privateSearchIndexes");
/** @typedef {import('./privateSearchQuery').SearchShape} Shape */
/** @typedef {import('./privateSearchIdentity').ReadScope} ReadScope */
/** @typedef {'opponents'|'customBuilds'|'maps'} Group */
/** @typedef {import('mongodb').Collection} Collection */
/** @typedef {{users:Collection,pendingIdentityDeletions:Collection,
 * opponents:Collection,customBuilds:Collection,games:Collection,
 * privateSearchIndexes?:import('../db/guideIndexes').BackgroundIndexBuilds}} SearchContext */
/** @typedef {ReturnType<typeof decodeCandidates>} Candidate */
/** @param {string} code */
const serviceError = code => Object.assign(new Error(code), { code, status: 503 });

/** @param {unknown} error */
function groupReason(error) {
  const field = error && typeof error === "object" ? Object.getOwnPropertyDescriptor(error, "code") : null;
  const code = field && Object.hasOwn(field, "value") ? field.value : null;
  if (code === "private_search_cleanup_failed") throw serviceError(code);
  if (code === "private_search_missing_access_path") return "missing_access_path";
  if (code === "private_search_deadline") return "deadline";
  if (code === "private_search_invalid_data") return "invalid_data";
  if (code === "private_search_retired") return "retired";
  throw serviceError("private_search_unavailable");
}

/** Read-only discovery and fresh publication without result caches or joins.
 * Optional map search stays deferred in the application configuration. */
class PrivateSearchService {
  /** @param {SearchContext} ctx
   * @param {{identityKeyFor:(clerkUserId:string)=>string,mapsEnabled?:boolean,
   * capacity?:PrivateSearchCapacity}} options */
  constructor(ctx, options) {
    this.ctx = ctx; this.mapsEnabled = options.mapsEnabled === true;
    this.capacity = options.capacity || new PrivateSearchCapacity();
    this.identity = new PrivateSearchIdentity(ctx, options.identityKeyFor);
  }

  /** Return one already-serialized, whole-body-bounded v2 response.
   * Example: quick(verifiedOwner, literalQuery, {signal, check}).
   * @param {string} owner @param {string} q @param {ReadScope} scope */
  async quick(owner, q, scope) {
    if (!validId(owner, 200)) {
      throw Object.assign(new Error("private_search_invalid_owner"), {
        code: "private_search_invalid_owner", status: 401 });
    }
    // Pure validation precedes permits and all DB work; no query text survives errors.
    try { query.opponents(owner, q); }
    catch {
      throw Object.assign(new Error("private_search_invalid_request"), {
        code: "private_search_invalid_request", status: 400 });
    }
    return this.capacity.run(owner, async () => {
      scope.check();
      if (scope.signal.aborted) throw serviceError("private_search_retired");
      await this.identity.assertActive(owner, scope);
      const opponents = await this.readGroup("opponents", owner, q, scope);
      const customBuilds = await this.readGroup("customBuilds", owner, q, scope);
      const maps = this.mapsEnabled ? await this.readGroup("maps", owner, q, scope) : unavailable("deferred");
      await this.identity.assertActive(owner, scope); scope.check();
      if (scope.signal.aborted) throw serviceError("private_search_retired");
      try { return serializeResponse({ opponents, customBuilds, maps }); }
      catch { throw serviceError("private_search_failed"); }
    });
  }

  /** @param {Group} group @param {string} owner @param {string} q @param {ReadScope} scope */
  async readGroup(group, owner, q, scope) {
    try {
      const readiness = group === "opponents" ? this.ctx.privateSearchIndexes?.status(PRIVATE_SEARCH_OPPONENT_INDEX) : null;
      if (readiness && readiness !== "ready") return unavailable("missing_access_path");
      const shape = group === "maps" ? query.maps(owner, q) : query[group](owner, q);
      const discovered = await this.candidates(group, shape, scope);
      if (discovered.dto.status !== "ready") return discovered.dto;
      if (group === "maps") return await this.publishMap(owner, q, discovered, scope);
      if (discovered.candidates.length === 0) return discovered.dto;
      const key = group === "opponents" ? "pulseId" : "slug";
      const ids = discovered.candidates.map(row => String(row[key]));
      const fresh = await this.candidates(group, query.publication(group, owner, q, ids), scope);
      if (fresh.dto.status !== "ready" || fresh.sourceCount !== ids.length
        || JSON.stringify(fresh.candidates) !== JSON.stringify(discovered.candidates)) return unavailable("retired");
      return fresh.dto;
    } catch (error) { return unavailable(groupReason(error)); }
  }

  /** A second exact capped facet is required; no unbounded map-exists lookup.
   * @param {string} owner @param {string} q @param {Candidate} discovered @param {ReadScope} scope */
  async publishMap(owner, q, discovered, scope) {
    const fresh = await this.candidates("maps", query.maps(owner, q), scope);
    if (fresh.dto.status !== "ready" || JSON.stringify(fresh.candidates) !== JSON.stringify(discovered.candidates)) {
      return unavailable("retired");
    }
    return fresh.dto;
  }

  /** @param {Group} group @param {Shape} shape @param {ReadScope} scope */
  async candidates(group, shape, scope) {
    const collection = group === "maps" ? this.ctx.games : this.ctx[group];
    const raw = await readPrivateFacet(collection, shape, scope.signal, scope.check);
    return decodeCandidates(group, raw.envelopes, raw.rawBsonBytes);
  }
}

module.exports = { PrivateSearchService };
