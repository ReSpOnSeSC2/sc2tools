"use strict";
const crypto = require("crypto");

class AdminAuditService {
  /** @param {{db:any}} deps */
  constructor(deps) { this.collection = deps.db.adminAudit; }
  /** @param {any} req @param {string} action @param {string|null} target @param {Record<string,any>} result */
  async audit(req, action, target, result) {
    try {
      await this.collection.insertOne({ auditId: crypto.randomUUID(), createdAt: new Date(), actorUserId: req.auth?.userId || null,
        action: action.slice(0, 160), target, result: safeResult(result) });
    } catch { /* Audit failure must not retry or roll back a successful operation. */ }
  }
  /** @param {{action?:string,target?:string,before?:string,limit?:number}} [options] */
  async list(options = {}) {
    const limit = Math.max(1, Math.min(100, Number(options.limit) || 50));
    const before = options.before ? new Date(options.before) : null;
    const filter = { ...(options.action ? { action: options.action.slice(0,160) } : {}), ...(options.target ? { target: options.target.slice(0,200) } : {}),
      ...(before && Number.isFinite(before.getTime()) ? { createdAt: { $lt: before } } : {}) };
    const rows = await this.collection.find(filter, { projection: { _id: 0 } }).sort({ createdAt: -1, auditId: -1 }).limit(limit + 1).toArray();
    return { items: rows.slice(0,limit), nextBefore: rows.length > limit ? rows[limit - 1].createdAt : null };
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
    const json = res.json;
    res.json = function(body) {
      res.locals.auditAction ||= `${req.method} ${String(req.route?.path || path)}`;
      res.locals.auditTarget ||= ["userId","buildId","reportId","requestId","channelId","pulseId","job"].map((key)=>req.params[key]).find((value)=>typeof value==="string") || null;
      res.locals.auditResult = { ...safeResult(body && typeof body === "object" ? body : {}), ...res.locals.auditResult,
        ...(body?.error?.code ? {code:body.error.code} : {}) };
      return json.call(this, body);
    };
    res.once("finish", () => {
      if (!isAdmin(req)) return;
      const target = res.locals.auditTarget || null;
      const action = res.locals.auditAction || `${req.method} ${String(req.route?.path || path).replace(/\/[^/:]+(?=\/(?:wipe-games|rebuild-opponents|grant-admin|revoke-admin)$)/, "/:userId")}`;
      void service.audit(req, action, target, { status: res.statusCode, ok: res.statusCode < 400, ...res.locals.auditResult });
    }); next();
  };
}
module.exports = { AdminAuditService, adminAuditMiddleware };
