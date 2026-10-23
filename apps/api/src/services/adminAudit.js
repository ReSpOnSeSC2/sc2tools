"use strict";
const crypto = require("crypto");
const { stampVersion } = require("../db/schemaVersioning");
const { COLLECTIONS } = require("../config/constants");
const { adminEventCursor, adminEventPageFilter } = require("./adminEventCursor");
const { claimUserDataLease } = require("../middleware/userDataWriteFence");

class AdminAuditService {
  /** @param {{db:any}} deps */
  constructor(deps) { this.collection = deps.db.adminAudit; this.users = deps.db.users; }
  /** @param {any} req @param {string} action @param {string|null} target @param {Record<string,any>} result */
  async audit(req, action, target, result) {
    const actor = req.auth?.userId || null;
    const userTarget = action.startsWith("user.") || action.startsWith("admin.") || action.includes(":userId");
    /** @type {Map<string,Awaited<ReturnType<typeof claimUserDataLease>>>} */
    const leases = new Map();
    try {
      for (const id of new Set([actor, userTarget ? target : null].filter(Boolean))) {
        try { leases.set(id, await claimUserDataLease(this.users, id)); } catch { /* Missing or erasing users are anonymized before insertion. */ }
      }
      for (const lease of leases.values()) await lease.assert();
      await this.collection.insertOne(stampVersion({ auditId: crypto.randomUUID(), createdAt: new Date(),
        actorUserId: actor && leases.has(actor) ? actor : null, actorKind: actor ? leases.has(actor) ? "user" : "anonymized" : "service", action: action.slice(0, 160),
        target: userTarget && (!target || !leases.has(target)) ? null : target,
        result: safeResult(result) }, COLLECTIONS.ADMIN_AUDIT));
    } catch { /* Audit failure must not retry or roll back a successful operation. */ }
    finally { await Promise.allSettled([...leases.values()].map((lease) => lease.release())); }
  }
  /** @param {{action?:string,target?:string,before?:string,limit?:number}} [options] */
  async list(options = {}) {
    const limit = Math.max(1, Math.min(100, Number(options.limit) || 50));
    const pageFilter = adminEventPageFilter(options.before);
    if (pageFilter.$or) pageFilter.$or = pageFilter.$or.map((/** @type {any} */ row) => row.eventId ? {createdAt:row.createdAt,auditId:row.eventId} : row);
    const filter = { ...(options.action ? { action: options.action.slice(0,160) } : {}), ...(options.target ? { target: options.target.slice(0,200) } : {}),
      ...pageFilter };
    const rows = await this.collection.find(filter, { projection: { _id: 0 } }).sort({ createdAt: -1, auditId: -1 }).limit(limit + 1).toArray();
    return { items: rows.slice(0,limit), nextBefore: rows.length > limit ? adminEventCursor({createdAt:rows[limit - 1].createdAt,eventId:rows[limit - 1].auditId}) : null };
  }
}
/** @param {Record<string,any>} result */
function safeResult(result) { return Object.fromEntries(Object.entries(result).filter(([key,value]) => /^[a-zA-Z]{1,40}$/.test(key) && (typeof value === "number" || typeof value === "boolean" || key === "code" && typeof value === "string" && /^[a-z0-9_]{1,64}$/.test(value))).slice(0,20)); }
/** Covers admin mutations across every router, without storing bodies, tokens or query strings.
 * @param {AdminAuditService} service @param {(req:any)=>boolean} isAdmin @returns {import('express').RequestHandler} */
function adminAuditMiddleware(service, isAdmin) {
  return (req, res, next) => {
    const path = req.path;
    if (!["POST","PUT","PATCH","DELETE"].includes(req.method) || !/(?:^|\/)admin(?:\/|$)/.test(path)) { next(); return; }
    let recorded = false;
    const record = () => {
      if (recorded || !isAdmin(req)) return;
      recorded = true;
      const target = res.locals.auditTarget || null;
      const action = res.locals.auditAction || `${req.method} ${String(req.route?.path || "unmatched-admin-mutation")}`;
      void service.audit(req, action, target, { status: res.statusCode, ok: res.statusCode < 400, ...res.locals.auditResult });
    };
    const json = res.json;
    res.json = function(body) {
      res.locals.auditAction ||= `${req.method} ${String(req.route?.path || "unmatched-admin-mutation")}`;
      res.locals.auditTarget ||= ["userId","buildId","reportId","requestId","channelId","pulseId","job"].map((key)=>req.params[key]).find((value)=>typeof value==="string") || null;
      res.locals.auditResult = { ...safeResult(body && typeof body === "object" ? body : {}), ...res.locals.auditResult,
        ...(body?.error?.code ? {code:body.error.code} : {}) };
      // A completed mutation is still auditable if its client disconnected
      // before this JSON result could emit finish. Never infer success on close.
      record(); return json.call(this, body);
    };
    res.once("finish", record); next();
  };
}
module.exports = { AdminAuditService, adminAuditMiddleware };
