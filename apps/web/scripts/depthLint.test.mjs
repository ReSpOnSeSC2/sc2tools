// Tests for scripts/depthLint.mjs; `npm run depth-lint` runs them before
// the lint itself. Each case writes a small modes folder and runs the
// script against it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./depthLint.mjs", import.meta.url));
// Helpers don't register, though a comment may name registerMode(...).
const HELPER =
  '// Read by bingo.tsx, which calls registerMode(ID, "forward").\nexport const CANDIDATES = [];\n';

// A minimal mode file; `declared: null` leaves out the depthTag line.
function mode(registered, declared = registered) {
  return [
    'const ID = "fixture";',
    `registerMode(ID, "${registered}");`,
    "export const fixture: Mode<Q, A> = {",
    "  id: ID,",
    declared === null ? "" : `  depthTag: "${declared}",`,
    "};",
    "",
  ].join("\n");
}

function lint(files) {
  const dir = mkdtempSync(join(tmpdir(), "depth-lint-"));
  try {
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), text);
    }
    const run = spawnSync(process.execPath, [SCRIPT, dir], { encoding: "utf8" });
    return { code: run.status, out: run.stdout + run.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("helper files beside the modes are skipped", () => {
  const { code, out } = lint({
    "index.ts": "// Each mode calls `registerMode(id, depthTag)`.\n",
    "games/bingo.tsx": mode("forward"),
    "games/bingo.candidates.ts": HELPER,
  });
  assert.equal(code, 0, out);
  assert.match(out, /depth-lint: ok \(1 mode files scanned, 1 helper files skipped\)/);
});

test("a mode without a depthTag fails", () => {
  const { code, out } = lint({ "quizzes/a.tsx": mode("temporal", null) });
  assert.equal(code, 1, out);
  assert.match(out, /a\.tsx: no depthTag literal found/);
});

test("an unknown depthTag fails", () => {
  const { code, out } = lint({ "quizzes/a.tsx": mode("shallow") });
  assert.equal(code, 1, out);
  assert.match(out, /a\.tsx: unknown depthTag "shallow"/);
});

test("a mode must register with its own depthTag", () => {
  const { code, out } = lint({
    "quizzes/a.tsx": mode("temporal").replace(/^registerMode.*\n/m, ""),
    "quizzes/b.tsx": mode("temporal", "forward"),
  });
  assert.equal(code, 1, out);
  assert.match(out, /a\.tsx: no registerMode\(<id>, "<depthTag>"\) call found/);
  assert.match(out, /b\.tsx: registerMode tag "temporal" disagrees with depthTag "forward"/);
});

test("a folder with no mode files fails", () => {
  const { code, out } = lint({ "games/bingo.candidates.ts": HELPER });
  assert.equal(code, 1, out);
  assert.match(out, /no mode files found/);
});
