/**
 * Pyodide parity test for the built browser engine (node:test, slow).
 *
 * 1. Reads public/engine/current.json -> manifest and verifies the SHA-256
 *    of EVERY asset on disk (fails when the bundle is missing: run
 *    `npm run engine:build`).
 * 2. Boots Pyodide in Node from those verified built assets
 *    (indexURL = public/pyodide/<version>/, engine.zip from the bundle) and
 *    activates the engine exactly like the worker (engineBoot.ts).
 * 3. Installs the worker's REAL Python glue (`ENGINE_GLUE_SOURCE`, read
 *    verbatim from lib/instant/enginePyGlue.ts) and smoke-tests
 *    `_sc2t_players` / `_sc2t_parse` (incl. digests) on a fixture replay.
 * 4. With INSTANT_GOLDEN_DIR set (output of
 *    `python apps/agent/tests/instant_golden.py --out DIR`), runs every
 *    golden case through the same glue call the worker makes and asserts
 *    the envelope, including the upload `json`, is IDENTICAL to CPython's.
 *
 * Usage:
 *   npm run engine:build && INSTANT_GOLDEN_DIR=/tmp/golden npm run test:engine
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO_DIR = path.resolve(WEB_DIR, "..", "..");
const PUBLIC_DIR = path.join(WEB_DIR, "public");
const POINTER_FILE = path.join(PUBLIC_DIR, "engine", "current.json");
const FIXTURE_DIR = process.env.INSTANT_FIXTURE_DIR
  ?? path.join(REPO_DIR, "apps", "replay-engine", "tests", "fixtures", "replays");
const GOLDEN_DIR = process.env.INSTANT_GOLDEN_DIR ?? "";
const SMOKE_FIXTURE = "warpgate_adept_tracking.SC2Replay";
const SMOKE_TOON = "1-S2-1-267727";
const INSTALLED_DATA_VIEW = "installed";
/** pyodide.mjs, pyodide.asm.mjs, pyodide.asm.wasm, python_stdlib.zip, engine.zip. */
const MANIFEST_ASSET_COUNT = 5;
/** Booting Pyodide + parsing a dozen replays takes ~30 s; leave headroom. */
const SLOW_TIMEOUT_MS = 600_000;
const BUILD_HINT = "run `npm run engine:build` in apps/web first";
const NO_OUTPUT = () => {};

/** The worker glue lives in TypeScript; its Python text is read verbatim. */
const GLUE_FILE = path.join(WEB_DIR, "lib", "instant", "enginePyGlue.ts");
const GLUE_SOURCE_RE = /export const ENGINE_GLUE_SOURCE = `([^`]*)`;/;
/** Same positional arguments engineWorkerHost.runParse passes (no display-name handle). */
const NO_HANDLE = "";
const WANT_DIGESTS = true;

const u8 = (buffer) => new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");
const md5Base64 = (buffer) => createHash("md5").update(buffer).digest("base64");

/** `ENGINE_GLUE_SOURCE` exactly as the worker runs it (a plain template: no escapes, no `${}`). */
async function workerGlueSource() {
  const match = GLUE_SOURCE_RE.exec(await readFile(GLUE_FILE, "utf8"));
  assert.ok(match, `could not find ENGINE_GLUE_SOURCE in ${path.relative(WEB_DIR, GLUE_FILE)}`);
  const source = match[1];
  assert.ok(!source.includes("\\") && !source.includes("${"), "ENGINE_GLUE_SOURCE must stay a plain template literal");
  return source;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

/** Pointer -> manifest -> every asset, verified against its digest. */
async function loadVerifiedBundle() {
  assert.ok(existsSync(POINTER_FILE), `missing ${path.relative(WEB_DIR, POINTER_FILE)}: ${BUILD_HINT}`);
  const pointer = await readJson(POINTER_FILE);
  const manifest = await readJson(path.join(PUBLIC_DIR, pointer.manifest));
  assert.equal(manifest.engineVersion, pointer.engineVersion, "pointer and manifest disagree on the engine version");
  const assets = new Map();
  for (const asset of manifest.assets) {
    const file = path.join(PUBLIC_DIR, asset.path);
    assert.ok(existsSync(file), `missing asset ${asset.path}: ${BUILD_HINT}`);
    const bytes = await readFile(file);
    assert.equal(bytes.length, asset.bytes, `${asset.path} size differs from the manifest`);
    assert.equal(sha256(bytes), asset.sha256, `${asset.path} does not match its manifest sha256`);
    assets.set(asset.role, { ...asset, bytes });
  }
  return { manifest, assets };
}

/** Same Python the worker runs after unpacking (engineBoot.activationCode). */
function activationCode(manifest) {
  return [
    "import importlib, json, logging, sys",
    `for _sc2t_entry in reversed(json.loads(${JSON.stringify(JSON.stringify(manifest.python.sysPath))})):`,
    "    if _sc2t_entry not in sys.path:",
    "        sys.path.insert(0, _sc2t_entry)",
    "importlib.invalidate_caches()",
    'logging.getLogger("sc2reader").setLevel(logging.CRITICAL)',
    `importlib.import_module(${JSON.stringify(manifest.python.module)})`,
  ].join("\n");
}

/** Node cannot import blob: URLs, so load the verified public files by path. */
async function bootFromBuiltAssets({ manifest, assets }) {
  const loader = assets.get("pyodide-loader");
  const indexURL = `${path.dirname(path.join(PUBLIC_DIR, loader.path))}${path.sep}`;
  const { loadPyodide } = await import(pathToFileURL(path.join(PUBLIC_DIR, loader.path)).href);
  const started = performance.now();
  const pyodide = await loadPyodide({
    indexURL,
    lockFileContents: { info: manifest.lockInfo, packages: {} },
    stdout: NO_OUTPUT,
    stderr: NO_OUTPUT,
    env: {},
  });
  pyodide.unpackArchive(u8(assets.get("engine-bundle").bytes), "zip", { extractDir: "/" });
  pyodide.runPython(activationCode(manifest));
  pyodide.runPython(await workerGlueSource());
  const glueParse = pyodide.globals.get("_sc2t_parse");
  const gluePlayers = pyodide.globals.get("_sc2t_players");
  return {
    pyodide,
    bootMs: performance.now() - started,
    /** Exactly the worker's call: (bytes, filename, toon or "", handle or "", wantDigests). */
    parse: (bytes, filename, toon) => JSON.parse(glueParse(u8(bytes), filename, toon ?? "", NO_HANDLE, WANT_DIGESTS)),
    players: (bytes, filename) => JSON.parse(gluePlayers(u8(bytes), filename)),
  };
}

let enginePromise = null;
function engine() {
  enginePromise ??= loadVerifiedBundle().then(async (bundle) => ({ bundle, ...(await bootFromBuiltAssets(bundle)) }));
  return enginePromise;
}

async function parseFixture(parse, fixture, filename, toon) {
  const bytes = await readFile(path.join(FIXTURE_DIR, fixture));
  return { bytes, ...parse(bytes, filename, toon) };
}

function firstDifference(left, right) {
  const limit = Math.min(left.length, right.length);
  for (let index = 0; index < limit; index += 1) if (left[index] !== right[index]) return index;
  return limit;
}

test("built bundle: every asset matches its manifest digest", { timeout: SLOW_TIMEOUT_MS }, async (t) => {
  const { manifest } = await loadVerifiedBundle();
  t.diagnostic(`bundle ${manifest.bundleId} (engine ${manifest.engineVersion}, pyodide ${manifest.pyodideVersion})`);
  assert.equal(manifest.assets.length, MANIFEST_ASSET_COUNT);
});

test("built bundle: boots in Pyodide and the worker glue parses a fixture", { timeout: SLOW_TIMEOUT_MS }, async (t) => {
  const { pyodide, parse, players, bundle, bootMs } = await engine();
  assert.equal(pyodide.version, bundle.manifest.pyodideVersion);
  const { bytes, envelope, digests } = await parseFixture(parse, SMOKE_FIXTURE, SMOKE_FIXTURE, SMOKE_TOON);
  assert.equal(envelope.ok, true, `smoke parse failed: ${envelope.errorKind}`);
  assert.equal(envelope.myToonHandle, SMOKE_TOON);
  assert.equal("payload" in envelope, false, "the glue must strip the payload (json carries it)");
  assert.deepEqual(digests, { sha256: sha256(bytes), md5: md5Base64(bytes), sizeBytes: bytes.length });
  const listed = players(bytes, SMOKE_FIXTURE);
  assert.equal(listed.ok, true, `list_replay_players failed: ${listed.errorKind}`);
  assert.ok(listed.players.some((player) => player.toon === SMOKE_TOON), "smoke toon missing from list_replay_players");
  t.diagnostic(`boot ${Math.round(bootMs)} ms, heap ${pyodide._module.HEAP8.length} B`);
});

/** A two-entry archive built with Python's own zipfile inside Pyodide (no JS zip dependency). */
const ZIP_FIXTURE_PY = [
  "import io, zipfile",
  "_sc2t_zip_buffer = io.BytesIO()",
  "with zipfile.ZipFile(_sc2t_zip_buffer, 'w') as _sc2t_zip:",
  "    _sc2t_zip.writestr(zipfile.ZipInfo('Replays/old.SC2Replay', (2020, 1, 2, 3, 4, 6)), b'MPQ-old')",
  "    _sc2t_zip.writestr(zipfile.ZipInfo('Replays/new.SC2Replay', (2026, 9, 1, 12, 0, 0)), b'MPQ-new')",
  "    _sc2t_zip.writestr('notes.txt', b'junk')",
  "_sc2t_zip_buffer.getvalue()",
].join("\n");
/** calendar.timegm of the two entry times above, in ms. */
const ZIP_FIXTURE_TIMES = [1577934246000, 1788264000000];

test("built bundle: the worker glue unzips replays with their entry times", { timeout: SLOW_TIMEOUT_MS }, async () => {
  const { pyodide } = await engine();
  const archive = pyodide.runPython(ZIP_FIXTURE_PY);
  const bytes = archive.toJs();
  archive.destroy();
  const header = JSON.parse(pyodide.globals.get("_sc2t_unzip")(bytes));
  pyodide.globals.get("_sc2t_unzip_done")();
  assert.deepEqual(header, {
    ok: true,
    names: ["Replays/old.SC2Replay", "Replays/new.SC2Replay"],
    lastModified: ZIP_FIXTURE_TIMES,
  });
});

test("built bundle: both Archon Drop labels require real completion proof by 6:00", { timeout: SLOW_TIMEOUT_MS }, async () => {
  const { pyodide } = await engine();
  const fixture = await readJson(path.join(REPO_DIR, "apps", "replay-engine", "tests", "fixtures", "archon_drop_parity.json"));
  // Use the same raw completion-clock examples as CPython and the agent.
  // Load the detector from the VERIFIED archive, never from this checkout.
  const result = pyodide.runPython([
    "import copy, json",
    "from core.strategy_detector_user import UserBuildDetector",
    "from core.strategy_detector_opponent import OpponentStrategyDetector",
    `fixture = json.loads(${JSON.stringify(JSON.stringify(fixture))})`,
    "results = []",
    "for kind, opening in fixture['openings'].items():",
    "    for case in fixture['cases']:",
    "        events = copy.deepcopy(opening['events'])",
    "        for index in range(case.get('archons', opening['archons'])):",
    "            events.append({'type': 'unit', 'name': 'Archon', 'time': 430 + index * 20, 'x': 10, 'y': 10})",
    "        if case['prism'] is not None:",
    "            events.append({'type': 'unit', 'name': 'WarpPrism', 'time': case['prism'], 'x': 10, 'y': 10})",
    "        for event in events:",
    "            if event['name'] == case.get('hallucinated'):",
    "                event['hallucinated'] = True",
    "        personal = UserBuildDetector(custom_builds=[]).detect_my_build('vs Zerg', events, my_race='Protoss', game_length_seconds=900)",
    "        opponent = OpponentStrategyDetector(custom_builds=[]).get_strategy_name('Protoss', events, matchup='vs Protoss', my_race='Zerg', game_length_seconds=900)",
    "        results.append({'kind': kind, 'id': case['id'], 'personal': personal, 'opponent': opponent})",
    "json.dumps(results)",
  ].join("\n"));
  const rows = JSON.parse(result);
  assert.equal(rows.length, Object.keys(fixture.openings).length * fixture.cases.length);
  for (const row of rows) {
    const opening = fixture.openings[row.kind];
    const example = fixture.cases.find((entry) => entry.id === row.id);
    if (example.matches) assert.equal(row.personal, opening.personal, `${row.kind}/${row.id}: valid drop`);
    else assert.ok(!row.personal.includes("Archon Drop"), `${row.kind}/${row.id}: false drop ${row.personal}`);
    assert.equal(row.opponent, opening.opponent, `${row.kind}/${row.id}: opponent taxonomy changed`);
  }
});

test("built bundle: early PvT DT commitment precedes Charge without invented late rushes", { timeout: SLOW_TIMEOUT_MS }, async () => {
  const { pyodide } = await engine();
  const fixture = await readJson(path.join(REPO_DIR, "apps/replay-engine/tests/fixtures/pvt_dt_priority.json"));
  const rows = JSON.parse(pyodide.runPython([
    "import copy, json",
    "from core.strategy_detector_user import UserBuildDetector",
    `fixture = json.loads(${JSON.stringify(JSON.stringify(fixture))})`,
    "results = []",
    "for case in fixture['cases']:",
    "    events = copy.deepcopy(fixture['events']) + copy.deepcopy(case.get('append', []))",
    "    events = [event for event in events if event['name'] not in case.get('remove', [])]",
    "    for event in events:",
    "        event['time'] = case.get('times', {}).get(event['name'], event['time'])",
    "        if event['name'] == case.get('hallucinated'):",
    "            event['hallucinated'] = True",
    "    label = UserBuildDetector(custom_builds=[]).detect_my_build('vs Terran', events, my_race='Protoss', game_length_seconds=900)",
    "    results.append(label)",
    "json.dumps(results)",
  ].join("\n")));
  assert.equal(rows.length, fixture.cases.length);
  fixture.cases.forEach((example, index) => assert.equal(rows[index], example.expected, example.id));
});

test(
  "built bundle: envelopes are identical to the CPython goldens",
  {
    timeout: SLOW_TIMEOUT_MS,
    skip: GOLDEN_DIR ? false : "INSTANT_GOLDEN_DIR is not set; generate goldens with "
      + "`python apps/agent/tests/instant_golden.py --out DIR` and re-run with INSTANT_GOLDEN_DIR=DIR",
  },
  async (t) => {
    const index = await readJson(path.join(GOLDEN_DIR, "index.json"));
    const { parse, bundle } = await engine();
    assert.equal(index.dataView, INSTALLED_DATA_VIEW, "goldens must use the installed data view (the bundle's)");
    assert.equal(index.engineProtocol, bundle.manifest.protocol, "golden engine protocol differs from the bundle");
    assert.ok(index.cases.length > 0, "golden index lists no cases");
    for (const entry of index.cases) {
      const golden = await readJson(path.join(GOLDEN_DIR, entry.file));
      const started = performance.now();
      const { envelope: actual } = await parseFixture(parse, golden.fixture, golden.filename, golden.runtime.player_toon);
      const ms = Math.round(performance.now() - started);
      const expected = golden.envelope;
      if (typeof expected.json === "string" && actual.json !== expected.json) {
        const at = firstDifference(actual.json ?? "", expected.json);
        assert.fail(`${entry.file}: payload json differs at offset ${at}`);
      }
      assert.equal(actual.gameId, expected.gameId, `${entry.file}: gameId`);
      assert.equal(actual.errorKind, expected.errorKind, `${entry.file}: errorKind`);
      assert.deepEqual(actual, expected, `${entry.file}: envelope`);
      t.diagnostic(`${entry.file}: identical (${ms} ms)`);
    }
  },
);

test("built bundle: active policy hashes, recorded clocks and detector surfaces match the shared runtime contract", { timeout: SLOW_TIMEOUT_MS }, async () => {
  const { pyodide } = await engine();
  const fixture = await readJson(path.join(REPO_DIR, "apps/replay-engine/tests/fixtures/preset_policy.json"));
  const result = pyodide.runPython([
    "import json, copy",
    "from core.preset_policy import validate_policy, apply_policy, policy_snapshot",
    "from core.strategy_detector import UserBuildDetector",
    `cases = json.loads(${JSON.stringify(JSON.stringify(fixture.cases))})`,
    "prior = policy_snapshot()",
    "results = []",
    "try:",
    "    for case in cases:",
    "        verified = validate_policy(case['policy'], verify_hash=False)",
    "        installed = _sc2t_policy(json.dumps(verified))",
    "        label = apply_policy(policy_snapshot(), case['baseline'], case['race'], case['opponentRace'], case['events'], UserBuildDetector([]), case.get('eightWorker', False), case.get('surface', 'you'))",
    "        results.append({'hash': installed, 'label': label})",
    "    last_hash = policy_snapshot()['hash']",
    "    broken = copy.deepcopy(policy_snapshot())",
    "    broken['evaluatorVersion'] = 999",
    "    try:",
    "        _sc2t_policy(json.dumps(broken))",
    "        raise AssertionError('incompatible policy accepted')",
    "    except ValueError:",
    "        pass",
    "    assert policy_snapshot()['hash'] == last_hash",
    "finally:",
    "    _sc2t_policy(json.dumps(prior))",
    "json.dumps(results)",
  ].join("\n"));
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  const rows = JSON.parse(result);
  assert.equal(rows.length, fixture.cases.length);
  for (const [index, row] of rows.entries()) {
    const policy = { ...fixture.cases[index].policy }; delete policy.hash;
    assert.equal(row.hash, createHash("sha256").update(JSON.stringify(canonical(policy))).digest("hex"), fixture.cases[index].name);
    assert.equal(row.label, fixture.cases[index].expected, fixture.cases[index].name);
  }
  assert.equal(rows[0].hash, fixture.hash);
});
