/** Run only on explicit generation. No package/prebuild hook or provider access. */
import { readFile, mkdir, rm, writeFile, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readBundleFiles } from "../apps/web/scripts/browser-engine/files.mjs";
import { bundleIdFor } from "../apps/web/scripts/browser-engine/publish.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = path.join(ROOT, "apps/web/public/try/sample-payloads.json");
const AVAILABILITY = path.join(ROOT, "apps/web/lib/instant/sampleAvailability.generated.ts");
const FIXTURES = ["warpgate_adept_tracking.SC2Replay", "ladder_zvt_winter_madness.SC2Replay", "ladder_tvt_tourmaline.SC2Replay", "ladder_tvz_ever_dream_18min.SC2Replay"];
const requireWeb = createRequire(path.join(ROOT, "apps/web/package.json"));
const sha = data => createHash("sha256").update(data).digest("hex");

export async function engineSourceHash() {
  const hash = createHash("sha256");
  for (const file of await readBundleFiles()) hash.update(file.path).update("\0").update(file.data).update("\0");
  return hash.digest("hex");
}
/** Same-version source/assets must not be accepted under a previous bundle ID. */
export function isSampleManifest(manifest, engineVersion, bundleId) {
  if (!manifest || manifest.engineVersion !== engineVersion || manifest.bundleId !== bundleId || !Array.isArray(manifest.assets)) return false;
  const assets = manifest.assets.filter(a => a.role === "engine-bundle");
  if (assets.length !== 1 || assets[0].path !== `/engine/${engineVersion}/${bundleId}/engine.zip` || !/^[a-f0-9]{64}$/.test(assets[0].sha256)) return false;
  return bundleIdFor({ ...manifest, bundleId: "", assets: manifest.assets.map(asset => asset.role === "engine-bundle" ? { ...asset, path: "" } : asset) }) === bundleId;
}
function run(command, args, timeout = 180_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, windowsHide: true, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", bytes = 0, settled = false;
    const fail = error => { if (settled) return; settled = true; clearTimeout(timer); child.kill(); reject(error); };
    const timer = setTimeout(() => fail(new Error("sample_engine_timeout")), timeout);
    child.on("error", fail);
    child.stdout.on("data", data => { bytes += data.length; if (bytes > 16 * 1024 * 1024) fail(new Error("sample_engine_output_limit")); else output += data; });
    // Python errors can contain fixture identities/paths; do not relay stderr.
    child.stderr.resume();
    child.on("close", code => { if (settled) return; settled = true; clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error("sample_engine_unavailable")); });
  });
}
async function loadProjector() {
  const { build } = requireWeb("esbuild");
  const result = await build({ entryPoints: [path.join(ROOT, "apps/web/lib/instant/sampleReport.ts")], bundle: true,
    write: false, platform: "node", format: "esm", target: "node22", logLevel: "silent" });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}
const PYTHON = String.raw`
import contextlib, hashlib, io, json, logging, os, pathlib, sys, tempfile, zipfile
root=pathlib.Path(sys.argv[1]); manifest=json.loads(sys.argv[2]); fixtures=json.loads(sys.argv[3]); files=json.loads(sys.argv[4])
asset=next(a for a in manifest['assets'] if a['role']=='engine-bundle')
blob=(root/'apps/web/public'/asset['path'].lstrip('/')).read_bytes()
assert hashlib.sha256(blob).hexdigest()==asset['sha256']
with tempfile.TemporaryDirectory(prefix='sc2tools-sample-') as temp, contextlib.ExitStack() as cleanup:
    target=pathlib.Path(temp)
    with zipfile.ZipFile(io.BytesIO(blob)) as archive:
        assert len(archive.infolist())<=1000 and sum(x.file_size for x in archive.infolist())<=32*1024*1024
        for info in archive.infolist():
            assert not info.filename.startswith('/') and '..' not in pathlib.PurePosixPath(info.filename).parts
        for name in files:
            source=(root/name).read_bytes().replace(b'\r\n',b'\n')
            assert archive.read('sc2tools/'+name)==source, 'sample_source_bundle_drift'
        archive.extractall(target)
    sys.path.insert(0,str(target/'lib/python3.14/site-packages'))
    sys.path.insert(0,str(target/'sc2tools/apps/agent'))
    cleanup.callback(os.chdir, os.getcwd())
    os.chdir(target)
    logging.disable(logging.CRITICAL)
    from sc2tools_agent.instant_analysis import RuntimeOptions, list_replay_players, parse_replay_bytes
    outputs=[]
    for filename in fixtures:
        data=(root/'apps/replay-engine/tests/fixtures/replays'/filename).read_bytes()
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            header=list_replay_players(data,filename='sample.SC2Replay')
            assert header.get('ok') and header.get('matchFormat')=='1v1' and not header.get('isAiGame')
            players=header.get('players',[]); assert len(players)==2
            selected=players[0]; assert selected.get('toon')
            parsed=parse_replay_bytes(data,filename='sample.SC2Replay',runtime=RuntimeOptions(player_toon=selected['toon']))
        assert parsed.get('ok') and parsed.get('matchFormat')=='1v1' and not parsed.get('isResumedFromReplay')
        payload=parsed['payload']; outputs.append(payload)
    print(json.dumps(outputs,separators=(',',':'),ensure_ascii=True))
`;

/** Failure removes only this generator's prior output; never serve a stale sample. */
export async function buildSampleReport({ output = OUTPUT, availability = AVAILABILITY, pythonCandidates = [process.env.PYTHON, "python3", "python"].filter(Boolean), execute = run } = {}) {
  let staging;
  const publishAvailability = async document => {
    const literal = value => JSON.stringify(value ?? null);
    await mkdir(path.dirname(availability), { recursive: true });
    await writeFile(availability, `// Generated by scripts/build-sample-report.mjs; never hand-edit.\nexport const SAMPLE_REPORT_AVAILABLE = ${!!document};\nexport const SAMPLE_REPORT_ENGINE_VERSION = ${literal(document?.engineVersion)};\nexport const SAMPLE_REPORT_BUNDLE_ID = ${literal(document?.engineBundleId)};\nexport const SAMPLE_REPORT_SOURCE_HASH = ${literal(document?.engineSourceHash)};\n`);
  };
  try {
    // A killed/failed regeneration cannot leave an earlier button advertised.
    await publishAvailability(null);
    let python;
    for (const candidate of pythonCandidates) {
      try { await execute(candidate, ["-c", "import sys; assert sys.version_info >= (3,10)"], 5000); python = candidate; break; } catch { /* Try the next installed interpreter; never install one. */ }
    }
    if (!python) { await rm(output, { force: true }); return { status: "skipped", reason: "python_unavailable" }; }
    const engineVersion = (await readFile(path.join(ROOT, "apps/replay-engine/VERSION"), "utf8")).trim();
    const pointer = JSON.parse(await readFile(path.join(ROOT, "apps/web/public/engine/current.json"), "utf8"));
    const expected = new RegExp(`^/engine/${engineVersion.replaceAll(".", "\\.")}/([a-f0-9]{16})/manifest\\.json$`).exec(pointer.manifest);
    if (pointer.engineVersion !== engineVersion || !expected) throw new Error("sample_engine_pointer_invalid");
    const manifest = JSON.parse(await readFile(path.join(ROOT, "apps/web/public", pointer.manifest.slice(1)), "utf8"));
    if (!isSampleManifest(manifest, engineVersion, expected[1])) throw new Error("sample_engine_manifest_invalid");
    const assets = manifest.assets?.filter(a => a.role === "engine-bundle");
    if (assets?.length !== 1 || assets[0].path !== `/engine/${engineVersion}/${expected[1]}/engine.zip` || !/^[a-f0-9]{64}$/.test(assets[0].sha256)) throw new Error("sample_engine_asset_invalid");
    const bundle = await readFile(path.join(ROOT, "apps/web/public", assets[0].path.slice(1)));
    if (sha(bundle) !== assets[0].sha256) throw new Error("sample_engine_digest_invalid");
    const files = await readBundleFiles(), sourceHash = await engineSourceHash();
    const raw = JSON.parse(await execute(python, ["-c", PYTHON, ROOT, JSON.stringify(manifest), JSON.stringify(FIXTURES), JSON.stringify(files.map(file => file.path))]));
    const { projectSampleGame, readSampleReport, SAMPLE_MAX_BYTES } = await loadProjector();
    if (!Array.isArray(raw) || raw.length !== FIXTURES.length) throw new Error("sample_engine_result_invalid");
    const games = raw.map(projectSampleGame);
    if (games.some(game => !game)) throw new Error("sample_projection_invalid");
    const document = { schemaVersion: 1, engineVersion, engineBundleId: manifest.bundleId, engineSourceHash: sourceHash, games };
    if (!readSampleReport(document, manifest.bundleId)) throw new Error("sample_schema_invalid");
    const text = JSON.stringify(document) + "\n";
    if (Buffer.byteLength(text) > SAMPLE_MAX_BYTES) throw new Error("sample_size_limit");
    await mkdir(path.dirname(output), { recursive: true }); staging = `${output}.tmp-${process.pid}`;
    await writeFile(staging, text); await rename(staging, output);
    await publishAvailability(document);
    return { status: "written", games: games.length, bytes: Buffer.byteLength(text), engineVersion, engineBundleId: manifest.bundleId, engineSourceHash: sourceHash };
  } catch {
    await rm(output, { force: true });
    return { status: "skipped", reason: "sample_engine_unavailable" };
  } finally { if (staging) await rm(staging, { force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await buildSampleReport()));
