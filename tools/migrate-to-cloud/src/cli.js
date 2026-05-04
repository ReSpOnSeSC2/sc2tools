"use strict";

const { parseArgs } = require("node:util");
const path = require("node:path");
const readline = require("node:readline");

const { readAll } = require("./read");
const { transform } = require("./transform");
const { uploadAll } = require("./upload");
const { reconcile } = require("./reconcile");

const HELP = `\
sc2tools-migrate — bulk-import a local SC2 Tools install into the cloud.

Usage:
  sc2tools-migrate [--local DIR] [--api URL] [--token TOKEN]
                   [--dry-run | --reconcile-only]
                   [--batch N] [--only kinds] [--verbose]

Flags:
  --local DIR         Local data folder (default: reveal-sc2-opponent-main/data)
  --api URL           Cloud API base (default: https://api.sc2tools.app)
  --token TOKEN       Clerk session/personal token. Prompted if omitted.
  --dry-run           Read + transform; do not write to the cloud.
  --reconcile-only    Skip uploads; print local-vs-cloud counts.
  --batch N           Games per POST (default: 25)
  --only kinds        Comma list: games, opponents, builds, profile (default: all)
  --verbose           Per-record trace
  --help              This message

Examples:
  sc2tools-migrate --dry-run
  sc2tools-migrate --api http://localhost:8080 --token clerk_session_xyz
  sc2tools-migrate --reconcile-only --api https://api.sc2tools.app
`;

const DEFAULTS = Object.freeze({
  local: "reveal-sc2-opponent-main/data",
  api: "https://api.sc2tools.app",
  batch: 25,
});

const KINDS = Object.freeze(["games", "opponents", "builds", "profile"]);

/**
 * Entry point.
 *
 * @param {string[]} argv
 * @returns {Promise<void>}
 */
async function main(argv) {
  const opts = parseCli(argv);
  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }

  if (!opts.token && !opts.dryRun) {
    opts.token = await promptStdin("Clerk session/personal token: ");
    if (!opts.token) {
      throw new Error("token required (paste from clerk.com → Users → Sessions)");
    }
  }

  log(opts, "info", `local=${opts.local}`);
  log(opts, "info", `api=${opts.api}`);
  log(opts, "info", `dryRun=${opts.dryRun} reconcileOnly=${opts.reconcileOnly}`);
  log(opts, "info", `kinds=${opts.kinds.join(",")} batch=${opts.batch}`);

  if (opts.reconcileOnly) {
    const report = await reconcile({
      local: opts.local,
      api: opts.api,
      token: opts.token,
      log: (l, m) => log(opts, l, m),
    });
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return;
  }

  log(opts, "info", "reading local files...");
  const raw = await readAll(opts.local);
  log(
    opts,
    "info",
    `read: opponents.json=${raw.opponentsCount}, ` +
      `meta.json builds=${raw.metaBuildsCount} games=${raw.metaGamesCount}, ` +
      `custom_builds=${raw.customBuildsCount}, profile=${raw.hasProfile}`,
  );

  log(opts, "info", "transforming to cloud shapes...");
  const xform = transform(raw);
  log(
    opts,
    "info",
    `prepared: games=${xform.games.length} ` +
      `customBuilds=${xform.customBuilds.length} ` +
      `profile=${xform.profile ? "yes" : "no"}`,
  );

  if (opts.dryRun) {
    summary("DRY RUN — would write:", xform);
    return;
  }

  const report = await uploadAll({
    api: opts.api,
    token: opts.token,
    batch: opts.batch,
    only: new Set(opts.kinds),
    payload: xform,
    log: (l, m) => log(opts, l, m),
  });

  log(opts, "info", "DONE");
  summary("Wrote:", { games: report.games, customBuilds: report.customBuilds });
  if (report.rejections.length > 0) {
    log(
      opts,
      "warn",
      `${report.rejections.length} record(s) rejected — see migration-report.json`,
    );
    const fs = require("node:fs/promises");
    await fs.writeFile(
      path.join(process.cwd(), "migration-report.json"),
      JSON.stringify(report, null, 2),
      "utf8",
    );
  }

  if (report.games.ok > 0 || report.customBuilds.ok > 0) {
    log(opts, "info", "running reconcile pass...");
    const r = await reconcile({
      local: opts.local,
      api: opts.api,
      token: opts.token,
      log: (l, m) => log(opts, l, m),
    });
    process.stdout.write(JSON.stringify(r, null, 2) + "\n");
  }
}

/** @param {string[]} argv */
function parseCli(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      local: { type: "string" },
      api: { type: "string" },
      token: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "reconcile-only": { type: "boolean", default: false },
      batch: { type: "string" },
      only: { type: "string" },
      verbose: { type: "boolean", default: false },
      help: { type: "boolean", default: false, short: "h" },
    },
    allowPositionals: false,
  });

  const kinds = (values.only || KINDS.join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const k of kinds) {
    if (!KINDS.includes(k)) {
      throw new Error(`--only: unknown kind '${k}'. Valid: ${KINDS.join(", ")}`);
    }
  }

  const batchN = values.batch ? Number.parseInt(values.batch, 10) : DEFAULTS.batch;
  if (!Number.isFinite(batchN) || batchN < 1 || batchN > 500) {
    throw new Error("--batch must be 1..500");
  }

  return {
    local: path.resolve(process.cwd(), values.local || DEFAULTS.local),
    api: (values.api || DEFAULTS.api).replace(/\/+$/, ""),
    token: values.token || "",
    dryRun: Boolean(values["dry-run"]),
    reconcileOnly: Boolean(values["reconcile-only"]),
    batch: batchN,
    kinds,
    verbose: Boolean(values.verbose),
    help: Boolean(values.help),
  };
}

/** @param {string} prompt */
function promptStdin(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: process.stdin.isTTY === true,
    });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve((answer || "").trim());
    });
  });
}

function log(opts, level, msg) {
  if (level === "trace" && !opts.verbose) return;
  const ts = new Date().toISOString();
  process.stderr.write(`[${ts}] ${level} ${msg}\n`);
}

function summary(label, payload) {
  process.stdout.write(`\n${label}\n`);
  for (const [k, v] of Object.entries(payload)) {
    if (Array.isArray(v)) {
      process.stdout.write(`  ${k}: ${v.length}\n`);
    } else if (v && typeof v === "object" && "ok" in v) {
      process.stdout.write(
        `  ${k}: ok=${v.ok} skipped=${v.skipped || 0} errors=${v.errors || 0}\n`,
      );
    } else if (v && typeof v === "object") {
      process.stdout.write(`  ${k}: ${Object.keys(v).length} field(s)\n`);
    } else {
      process.stdout.write(`  ${k}: ${v}\n`);
    }
  }
}

module.exports = { main };
