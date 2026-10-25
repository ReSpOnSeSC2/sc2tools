"use strict";
const express = require("express");
/** Public, anonymous and identical across users; contains released preset
 * labels/declarative criteria only. Existing user/device credentials are never
 * sent to this endpoint. Clients retain their last compatible verified policy.
 * @param {import('../services/presetPolicies').PresetPoliciesService} policies */
function buildPresetPolicyRouter(policies) {
  const router = express.Router();
  router.get("/build-policy", async (req, res, next) => {
    try {
      if (req.query.evaluator !== "1") { res.status(426).json({ error: { code: "preset_policy_client_upgrade_required" } }); return; }
      const policy = await policies.current();
      const etag = `"${policy.hash}"`;
      res.set({ "Cache-Control": "public, max-age=30, stale-if-error=300", ETag: etag });
      if (req.get("If-None-Match") === etag) { res.status(304).end(); return; }
      res.json(policy);
    } catch (error) { next(error); }
  });
  return router;
}
module.exports = { buildPresetPolicyRouter };
