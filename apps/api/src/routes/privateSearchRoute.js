"use strict";

const express = require("express");
const { validText } = require("../services/privateSearchText");
const { record } = require("../services/privateSearchDecode");
const { safePrivateSearchError, privateSearchErrorBoundary } = require("../middleware/privateSearchBoundary");
const DEADLINE_MS = 5000;
/** @param {string} code @param {number} [status] */
const routeError = (code, status = 400) => Object.assign(new Error(code), { code, status });

/** Reject controls/surrogates before trimming; never add public aliases.
 * @param {unknown} body */
function parseQuery(body) {
  let value;
  try { value = record(body, ["q"]).q; }
  catch { throw routeError("private_search_invalid_request"); }
  if (typeof value !== "string" || !validText(value, value.length, true)) {
    throw routeError("private_search_invalid_request");
  }
  const q = value.trim(), points = Array.from(q).length;
  if (points < 2 || points > 80 || Buffer.byteLength(q, "utf8") > 320) {
    throw routeError("private_search_invalid_request");
  }
  return q;
}

/** Own the HTTP deadline; the service capacity lane survives until real work settles.
 * @param {import('express').Request} req @param {import('express').Response} res */
function lifetime(req, res) {
  const controller = new AbortController();
  const disconnect = () => { if (!res.writableEnded) controller.abort(); };
  req.once("aborted", disconnect); res.once("close", disconnect);
  let expired = false;
  const timer = setTimeout(() => { expired = true; controller.abort(); }, DEADLINE_MS);
  const check = () => {
    if (controller.signal.aborted) {
      throw routeError(expired ? "private_search_deadline" : "private_search_retired", 503);
    }
  };
  return { signal: controller.signal, check,
    /** @template T @param {Promise<T>} work @returns {Promise<T>} */
    wait(work) {
      return new Promise((resolve, reject) => {
        const abort = () => { try { check(); } catch (error) { reject(error); } };
        controller.signal.addEventListener("abort", abort, { once: true });
        work.then(value => { controller.signal.removeEventListener("abort", abort); resolve(value); },
          error => { controller.signal.removeEventListener("abort", abort); reject(error); });
        if (controller.signal.aborted) abort();
      });
    },
    close() {
      clearTimeout(timer); req.removeListener("aborted", disconnect); res.removeListener("close", disconnect);
    },
  };
}

/** Mount beneath /v1 with the existing wrapped authenticator. No auth bypass.
 * @param {{privateSearch:import('../services/privateSearchService').PrivateSearchService,
 * auth:import('express').RequestHandler}} deps */
function buildPrivateSearchRouter(deps) {
  const router = express.Router();
  router.all("/search/quick", (_req, res, next) => { res.set("Cache-Control", "private, no-store"); next(); });
  router.post("/search/quick", deps.auth, async (req, res, next) => {
    /** @type {ReturnType<typeof lifetime>|undefined} */ let clock;
    try {
      const auth = req.auth;
      if (!auth || !validText(auth.userId, 200) || !["clerk", "device"].includes(auth.source)) {
        throw routeError("private_search_invalid_owner", 401);
      }
      if (auth.source === "clerk" && !validText(auth.clerkUserId, 200)) {
        throw routeError("private_search_invalid_owner", 401);
      }
      if (!req.is("application/json")) throw routeError("private_search_unsupported_media_type", 415);
      const q = parseQuery(req.body); clock = lifetime(req, res);
      const result = await clock.wait(deps.privateSearch.quick(auth.userId, q,
        { signal: clock.signal, check: clock.check, clerkUserId: auth.clerkUserId }));
      clock.check();
      if (!res.destroyed) {
        // End the already-bounded JSON directly: Express.send would generate
        // an ETag and could turn conditional requests into a private304 path.
        res.status(200).type("application/json").set("Content-Length", String(Buffer.byteLength(result))).end(result);
      }
    } catch (error) { if (!res.destroyed) next(safePrivateSearchError(error)); }
    finally { clock?.close(); }
  });
  router.all("/search/quick", (_req, res, next) => {
    res.set("Allow", "POST"); next(routeError("private_search_method_not_allowed", 405));
  });
  router.use(privateSearchErrorBoundary);
  return router;
}

module.exports = { buildPrivateSearchRouter, parseQuery, DEADLINE_MS, createPrivateSearchLifetime: lifetime };
