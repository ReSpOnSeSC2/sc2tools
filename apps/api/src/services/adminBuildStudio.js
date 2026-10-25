"use strict";
const { ObjectId } = require("mongodb");
const { randomUUID } = require("crypto");
const { claimUserDataLease } = require("../middleware/userDataWriteFence");
const { publicBuildMongoExpression, publicBuildSnapshot, PUBLIC_BUILD_FIELDS } = require("./communityBuildSnapshot");
const { validateCustomBuild } = require("../validation/customBuild");
const { catalog, validatePolicy, applyPolicy, presetScope } = require("./presetPolicy");
const EDITABLE = new Set(PUBLIC_BUILD_FIELDS);

class AdminBuildStudioService {
  /** @param {import('../db/connect').DbContext} db @param {{customBuilds:import('./customBuilds').CustomBuildsService,policies:import('./presetPolicies').PresetPoliciesService,onCommunityChanged?:()=>void}} deps */
  constructor(db, deps) { this.db = db; this.customBuilds = deps.customBuilds; this.policies = deps.policies; this.onCommunityChanged = deps.onCommunityChanged || null; }
  notifyCommunityChanged() { try { this.onCommunityChanged?.(); } catch { /* Public commit/unknown outcome remains authoritative. */ } }

  /** Stable keyset traversal exposes every definition, without a first-page cap masquerading as the catalog.
   * @param {string} scope @param {{after?:string,owner?:string}} [options] */
  async list(scope, options = {}) {
    if (scope === "preset") {
      const policy = await this.policies.current();
      const rows = catalog.definitions.filter((entry) => !options.after || entry.name > options.after).slice(0, 51);
      return { items: rows.slice(0, 50).map((entry) => ({ id: entry.name, name: entry.name, race: entry.race, scope, owner: null, source: catalog.source, mode: entry.implementation, surfaces: entry.surfaces, replaced: policy.entries.some((/** @type {any} */ candidate) => candidate.name === entry.name) })), nextAfter: rows.length > 50 ? rows[49].name : null };
    }
    const collection = this.collection(scope);
    const filter = { ...(scope === "custom" ? { deletedAt: { $exists: false } } : {}), ...(options.after ? { _id: { $gt: objectId(options.after) } } : {}), ...(options.owner ? { [scope === "custom" ? "userId" : "ownerUserId"]: options.owner } : {}) };
    const content = scope === "custom" ? "$$ROOT" : "$build";
    const rows = await collection.aggregate([{ $match: filter }, { $sort: { _id: 1 } }, { $limit: 51 }, { $project: {
      _id: 1, slug: bounded("$slug", 80), owner: bounded(scope === "custom" ? "$userId" : "$ownerUserId", 200), sourceSlug: bounded("$sourceSlug", 80), removed: { $eq: ["$removed", true] },
      // Catalog rows never hydrate rule/step arrays just to show their name.
      build: { name: bounded(`${content}.name`, 120), race: bounded(`${content}.race`, 16), hasSteps: { $cond: [{ $isArray: `${content}.steps` }, { $gt: [{ $size: `${content}.steps` }, 0] }, false] } }, updatedAt: 1,
    } }]).toArray();
    return { items: rows.slice(0, 50).map((row) => ({ id: String(row._id), scope, owner: row.owner, sourceSlug: row.sourceSlug, slug: row.slug, name: row.build.name || row.slug, race: row.build.race || null, removed: row.removed, mode: row.build.hasSteps ? "steps" : "rule-only", updatedAt: row.updatedAt })), nextAfter: rows.length > 50 ? String(rows[49]._id) : null };
  }

  /** @param {string} scope @param {string} id @returns {Promise<Record<string,any>>} */
  async detail(scope, id) {
    if (scope === "preset") {
      const released = catalog.definitions.find((entry) => entry.name === id);
      if (!released) throw problem(404, "build_definition_not_found");
      const policy = await this.policies.current(true);
      const replacement = policy.entries.find((/** @type {any} */ entry) => entry.name === id) || null;
      return { id, scope, owner: null, released, source: catalog.source, mode: replacement?.steps?.length ? "steps" : "rule-only", replacement, expectedHash: policy.hash, policyRevision: policy.revision, evaluatorVersion: policy.evaluatorVersion, schemaVersion: policy.schemaVersion, releaseHash: catalog.releaseHash, runtime: { protocol: "preset-policy-v1", cacheSeconds: 60, eventCapPerAxis: 5000, legacy: "released client labels retained; update/reanalyse to use active policy", existingGames: "unchanged until reanalysed" } };
    }
    const content = scope === "custom" ? "$$ROOT" : "$build";
    const row = await this.collection(scope).aggregate([{ $match: { _id: objectId(id), ...(scope === "custom" ? { deletedAt: { $exists: false } } : {}) } }, { $limit: 1 }, { $project: {
      _id: 0, slug: bounded("$slug", 80), owner: bounded(scope === "custom" ? "$userId" : "$ownerUserId", 200), sourceSlug: bounded("$sourceSlug", 80), title: bounded("$title", 120), description: bounded("$description", 4000),
      removed: { $eq: ["$removed", true] }, build: publicBuildMongoExpression(content), definitionCounts: definitionCounts(content),
      revision: { $ifNull: [scope === "custom" ? "$definitionRevision" : "$publicationSequence", 0] }, updatedAt: 1,
      history: { $map: { input: { $slice: [{ $cond: [{ $isArray: "$_definitionHistory" }, "$_definitionHistory", []] }, -10] }, as: "revision", in: { revision: "$$revision.revision", savedAt: "$$revision.savedAt", build: publicBuildMongoExpression("$$revision.build"), title: bounded("$$revision.title", 120), description: bounded("$$revision.description", 4000) } } },
    } }]).next();
    if (!row) throw problem(404, "build_definition_not_found");
    const clean = publicBuildSnapshot(row.build);
    const truncated = Object.entries(row.definitionCounts || {}).some(([field, count]) => count !== (Array.isArray(clean[field]) ? clean[field].length : 0));
    return { id, scope, ...row, truncated, name: row.build.name || row.slug, build: clean, history: row.history.map((/** @type {any} */ revision) => ({ ...revision, build: publicBuildSnapshot(revision.build) })), mode: row.build.steps?.length ? "steps" : "rule-only" };
  }

  /** @param {string} scope @param {string} id @param {any} input */
  async save(scope, id, input) {
    if (scope === "preset") {
      if (!input || Object.keys(input).some((key) => !["expectedHash", "replacement"].includes(key))) throw problem(400, "invalid_build_definition");
      const current = await this.detail(scope, id);
      const policy = await this.policies.current(true);
      if (policy.hash !== input.expectedHash) throw problem(409, "preset_policy_changed");
      const entries = policy.entries.filter((/** @type {any} */ entry) => entry.name !== id);
      if (input.replacement !== null) {
        if (input.replacement?.name !== id) throw problem(400, "preset_name_immutable");
        entries.push(input.replacement);
      }
      validatePolicy({ schemaVersion: current.schemaVersion, evaluatorVersion: current.evaluatorVersion, revision: policy.revision + 1, entries }, false);
      await this.policies.save(input.expectedHash, entries);
      return this.detail(scope, id);
    }
    if (!input || Object.keys(input).some((key) => !["expectedRevision", "build", "title", "description", "reclassify"].includes(key)) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || input.reclassify !== undefined && typeof input.reclassify !== "boolean") throw problem(400, "invalid_build_definition");
    const current = await this.detail(scope, id);
    if (!current.owner) throw problem(409, "build_owner_unavailable");
    if (current.truncated) throw problem(409, "legacy_definition_requires_repair");
    const build = editableBuild(input.build, current.slug);
    const lease = await claimUserDataLease(this.db.users, current.owner);
    try {
      await lease.assert();
      if (scope === "custom") {
        await this.customBuilds.upsert(current.owner, { slug: current.slug, ...build }, { expectedRevision: input.expectedRevision, expectedId: id, recordHistory: true });
        await lease.assert();
        if (input.reclassify) await this.customBuilds.enqueueReclassifyAll(current.owner, { clearUnmatched: true });
      } else {
        const title = input.title === undefined ? current.title : input.title;
        const description = input.description === undefined ? current.description : input.description;
        if (typeof title !== "string" || !title.trim() || title.length > 120 || typeof description !== "string" || description.length > 4000) throw problem(400, "invalid_build_definition");
        let saved;
        try { saved = await this.db.communityBuilds.updateOne({ _id: objectId(id), ownerUserId: current.owner, ...(input.expectedRevision === 0 ? { $or: [{ publicationSequence: 0 }, { publicationSequence: { $exists: false } }] } : { publicationSequence: input.expectedRevision }) }, /** @type {import('mongodb').Document} */ ({
          $set: { build: publicBuildSnapshot(build), title, description, updatedAt: new Date(), publicationRevision: randomUUID() }, $inc: { publicationSequence: 1 },
          $push: { _definitionHistory: { $each: [{ revision: current.revision, savedAt: new Date(), build: current.build, title: current.title, description: current.description }], $slice: -10 } },
        })); } catch (error) { this.notifyCommunityChanged(); throw error; }
        if (!saved.matchedCount) throw problem(409, "build_definition_changed");
        this.notifyCommunityChanged();
      }
      await lease.assert();
      return this.detail(scope, id);
    } finally { await lease.release(); }
  }

  /** @param {string} scope @param {string} id @param {number} expectedRevision @param {number} revision */
  async revert(scope, id, expectedRevision, revision) {
    if (scope === "preset") throw problem(400, "use_policy_revision_revert");
    const current = await this.detail(scope, id);
    const previous = current.history.find((/** @type {any} */ row) => row.revision === revision);
    if (!previous) throw problem(404, "build_definition_revision_not_found");
    return this.save(scope, id, { expectedRevision, build: previous.build, ...(scope === "community" ? { ...(typeof previous.title === "string" ? { title: previous.title } : {}), ...(typeof previous.description === "string" ? { description: previous.description } : {}) } : {}) });
  }

  /** Validate/evaluate an unsaved replacement against a bounded synthetic/raw
   * event list. Never reclassifies or changes a check-in. No replay IDs needed.
   * @param {string} name @param {any} replacement @param {any[]} events @param {string} baseline */
  preview(name, replacement, events, baseline) {
    if (!Array.isArray(events) || events.length > 5000 || !events.every((event) => event && ["building", "unit", "worker", "upgrade"].includes(event.type) && typeof event.name === "string" && /^[A-Za-z][A-Za-z0-9]{0,79}$/.test(event.name) && typeof event.time === "number" && Number.isFinite(event.time) && event.time >= 0 && event.time <= 86400)) throw problem(400, "invalid_policy_preview_events");
    if (replacement?.name !== name || !catalog.definitions.some((entry) => entry.name === name)) throw problem(400, "unknown_or_duplicate_preset");
    const policy = validatePolicy({ schemaVersion: 1, evaluatorVersion: 1, revision: 0, entries: [replacement] }, false);
    const [race, partner] = presetScope(name);
    if (baseline !== undefined && (typeof baseline !== "string" || baseline.length > 200 || baseline !== `Unclassified - ${race}` && !catalog.definitions.some((entry) => entry.name === baseline))) throw problem(400, "invalid_policy_preview_baseline");
    return { label: applyPolicy(policy, baseline || name, race || "Unknown", partner, events, undefined, /** @type {"you"|"opponent"} */ (catalog.definitions.find((entry) => entry.name === name)?.surfaces[0])), hash: policy.hash, evaluatorVersion: policy.evaluatorVersion };
  }
  /** @param {string} scope */
  collection(scope) {
    if (scope === "custom") return this.db.customBuilds;
    if (scope === "community") return this.db.communityBuilds;
    throw problem(400, "invalid_build_scope");
  }
}
/** Legacy documents exceeding valid definition bounds must never be silently
 * truncated by an edit. Scalars/unknown private children remain excluded.
 * @param {string} path */
function definitionCounts(path) {
  return Object.fromEntries(["signature", "rules", "steps", "winConditions", "losesTo", "transitionsInto"].map(field => [field, { $size: { $cond: [{ $isArray: `${path}.${field}` }, `${path}.${field}`, []] } }]));
}
/** @param {any} input @param {string} slug */
function editableBuild(input, slug) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !EDITABLE.has(key))) throw problem(400, "invalid_build_definition_fields");
  const checked = validateCustomBuild({ ...input, slug });
  if (!checked.valid) throw problem(400, "invalid_build_definition");
  return publicBuildSnapshot(/** @type {any} */ (checked.value));
}
/** @param {string} id */
function objectId(id) { if (!/^[a-fA-F0-9]{24}$/.test(id)) throw problem(400, "invalid_build_id"); return new ObjectId(id); }
/** @param {string} path @param {number} max */
function bounded(path, max) { return { $cond: [{ $eq: [{ $type: path }, "string"] }, { $substrCP: [path, 0, max] }, null] }; }
/** @param {number} status @param {string} code */
function problem(status, code) { return Object.assign(new Error(code), { status, code }); }
module.exports = { AdminBuildStudioService, editableBuild };
