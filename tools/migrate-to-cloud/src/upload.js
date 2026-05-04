"use strict";

/**
 * Push transformed payloads at the cloud API. Handles:
 *   - chunked POST /v1/games (game records also auto-create opponents)
 *   - per-slug PUT /v1/custom-builds/<slug>
 *   - PUT /v1/me for the profile
 *
 * Backs off on 429 and retries idempotent requests on transient 5xx.
 *
 * @param {{
 *   api: string,
 *   token: string,
 *   batch: number,
 *   only: Set<string>,
 *   payload: { games: object[], customBuilds: object[], profile: object|null },
 *   log: (level: string, msg: string) => void,
 * }} args
 */
async function uploadAll(args) {
  const { api, token, batch, only, payload, log } = args;
  const headers = {
    "content-type": "application/json",
    accept: "application/json",
    authorization: `Bearer ${token}`,
  };

  const report = {
    games: { ok: 0, skipped: 0, errors: 0 },
    customBuilds: { ok: 0, skipped: 0, errors: 0 },
    profile: null,
    rejections: [],
  };

  if (only.has("profile") && payload.profile) {
    log("info", "uploading profile...");
    const r = await postWithRetry(
      `${api}/v1/me`,
      { method: "PUT", headers, body: JSON.stringify(payload.profile) },
      log,
    );
    report.profile = r.ok ? "ok" : `error:${r.status}`;
    if (!r.ok) {
      report.rejections.push({ kind: "profile", status: r.status, body: r.body });
    }
  } else {
    log("info", "skipping profile (excluded or missing)");
  }

  if (only.has("games") || only.has("opponents")) {
    let i = 0;
    let batchNo = 0;
    while (i < payload.games.length) {
      batchNo += 1;
      const slice = payload.games.slice(i, i + batch);
      const r = await postWithRetry(
        `${api}/v1/games`,
        { method: "POST", headers, body: JSON.stringify({ games: slice }) },
        log,
      );
      if (!r.ok) {
        report.games.errors += slice.length;
        report.rejections.push({
          kind: "games",
          batch: batchNo,
          status: r.status,
          body: r.body,
        });
        log("warn", `games batch ${batchNo} failed: ${r.status}`);
      } else {
        const accepted = (r.json && r.json.accepted) || [];
        const rejected = (r.json && r.json.rejected) || [];
        report.games.ok += accepted.length;
        report.games.errors += rejected.length;
        for (const rej of rejected) {
          report.rejections.push({
            kind: "games",
            gameId: rej.gameId,
            errors: rej.errors,
          });
        }
        log(
          "info",
          `games batch=${batchNo} ok=${accepted.length} ` +
            `rejected=${rejected.length} (running total ok=${report.games.ok})`,
        );
      }
      i += batch;
    }
  } else {
    log("info", "skipping games");
  }

  if (only.has("builds")) {
    let n = 0;
    for (const b of payload.customBuilds) {
      n += 1;
      const r = await postWithRetry(
        `${api}/v1/custom-builds/${encodeURIComponent(b.slug)}`,
        { method: "PUT", headers, body: JSON.stringify(b) },
        log,
      );
      if (!r.ok) {
        report.customBuilds.errors += 1;
        report.rejections.push({
          kind: "custom-builds",
          slug: b.slug,
          status: r.status,
          body: r.body,
        });
        log("warn", `build '${b.slug}' failed: ${r.status}`);
      } else {
        report.customBuilds.ok += 1;
      }
      if (n % 10 === 0) {
        log("info", `customBuilds progress ${n}/${payload.customBuilds.length}`);
      }
    }
  } else {
    log("info", "skipping custom builds");
  }

  return report;
}

/**
 * Wrap fetch with simple retries on 429 and 5xx.
 *
 * @returns {Promise<{ok: boolean, status: number, body: string, json: any}>}
 */
async function postWithRetry(url, init, log) {
  const MAX = 5;
  let attempt = 0;
  let lastErr = null;
  while (attempt < MAX) {
    attempt += 1;
    try {
      const res = await fetch(url, init);
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      if (res.ok) return { ok: true, status: res.status, body: text, json };
      if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
        const wait = Math.min(1000 * 2 ** (attempt - 1), 15000);
        log("warn", `${res.status} on ${url}; retrying in ${wait}ms`);
        await sleep(wait);
        continue;
      }
      return { ok: false, status: res.status, body: text, json };
    } catch (err) {
      lastErr = err;
      const wait = Math.min(1000 * 2 ** (attempt - 1), 15000);
      log("warn", `network error: ${String(err && err.message)}; retrying in ${wait}ms`);
      await sleep(wait);
    }
  }
  return {
    ok: false,
    status: 0,
    body: lastErr ? String(lastErr.message || lastErr) : "exhausted retries",
    json: null,
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { uploadAll };
