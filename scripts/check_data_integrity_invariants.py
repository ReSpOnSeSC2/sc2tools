#!/usr/bin/env python3
"""Stage 7 of STAGE_DATA_INTEGRITY_ROADMAP -- CI lint rules.

Three rules, each gated by basename allow-lists:

  * **Python**: ``tempfile.mkstemp`` outside the canonical atomic
    helper or the recovery / integrity-sweep modules. The Stage 2
    audit consolidated every Python writer onto
    ``core.atomic_io.atomic_write_json``; this rule prevents new
    drift by failing CI on any future file that reaches for
    ``mkstemp`` directly.

  * **Node**:   ``fs.openSync(*, 'wx')`` outside ``lib/atomic-fs.js``
    and ``lib/file-lock.js``. Same reasoning as the Python rule.

  * **PowerShell**: ``Out-File`` / ``Set-Content`` / ``Move-Item``
    against a ``data\\*.json`` path outside
    ``lib/Lock-FileAtomic.ps1``. Closes the corresponding hole on
    the PowerShell side.

The lint is line-based with comment-strip; doc-comments mentioning
the forbidden API are not flagged.

Suppression escape hatch
------------------------

For a documented one-off, append a ``# noqa: SC2_ATOMIC_FS`` (Python),
``// eslint-disable-next-line sc2-atomic-fs`` (Node), or
``# Suppress: Lock-FileAtomic`` (PowerShell) comment on the same
line. Use sparingly -- the next reviewer will ask why.

Usage::

    python scripts/check_data_integrity_invariants.py
    python scripts/check_data_integrity_invariants.py --verbose
    python scripts/check_data_integrity_invariants.py --paths reveal-sc2-opponent-main

Exit codes::

    0  no violations
    1  one or more violations found
    2  invocation error
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from typing import Iterable, List

PROD_ROOTS = ("reveal-sc2-opponent-main",)
EXCLUDE_DIRS = {
    "node_modules", "__pycache__", "__tests__", "tests",
    "dist", "build", "packaging", ".git", ".claude", ".vscode",
    "worktrees",
}

# Files that legitimately use the forbidden APIs because they ARE
# the canonical helper. Suppressed by exact relative path.
PY_MKSTEMP_ALLOWLIST = {
    os.path.join("reveal-sc2-opponent-main", "core", "atomic_io.py"),
    os.path.join("reveal-sc2-opponent-main", "core", "integrity_sweep.py"),
    os.path.join("reveal-sc2-opponent-main", "scripts", "recover_orphan_history.py"),
    os.path.join("reveal-sc2-opponent-main", "scripts", "bulk_import_cli.py"),
}
NODE_OPEN_WX_ALLOWLIST = {
    os.path.join("reveal-sc2-opponent-main", "stream-overlay-backend", "lib", "atomic-fs.js"),
    os.path.join("reveal-sc2-opponent-main", "stream-overlay-backend", "lib", "file-lock.js"),
    # integrity_sweep.applyCandidate uses fs.openSync + fsync to swap a
    # candidate file in -- documented in the function header as a sibling
    # of the canonical helper (Stage 5 of STAGE_DATA_INTEGRITY_ROADMAP).
    os.path.join("reveal-sc2-opponent-main", "stream-overlay-backend", "lib", "integrity_sweep.js"),
}
PS_DATA_WRITE_ALLOWLIST = {
    os.path.join("reveal-sc2-opponent-main", "lib", "Lock-FileAtomic.ps1"),
    # Reveal-Sc2Opponent.ps1 is the legitimate writer of
    # MyOpponentHistory.json; its Save-History wraps Lock-FileAtomic.
    os.path.join("reveal-sc2-opponent-main", "Reveal-Sc2Opponent.ps1"),
}

PY_MKSTEMP_RE = re.compile(r"\btempfile\.mkstemp\s*\(")
PY_NOQA_RE = re.compile(r"#\s*noqa:\s*SC2_ATOMIC_FS\b")

NODE_OPEN_WX_RE = re.compile(
    r"\bfs\.openSync\s*\([^,]+,\s*['\"]w[xt+]?['\"]"
)
NODE_NOQA_RE = re.compile(
    r"//\s*eslint-disable-(?:next-line|line)\s+sc2-atomic-fs"
)

# PowerShell rule: forbid raw writes against a data\*.json path. We
# match Out-File / Set-Content / Move-Item / WriteAllText with a
# right-hand side mentioning ``data`` and ``.json``. Loose by design --
# allow-list the legitimate writers.
PS_DATA_WRITE_RE = re.compile(
    r"(?:Out-File|Set-Content|Add-Content|Move-Item|Rename-Item|"
    r"\.WriteAllText|\.WriteAllBytes|\.WriteAllLines)"
)
PS_DATA_PATH_HINT_RE = re.compile(r"data[\\\/].*\.json", re.IGNORECASE)
PS_NOQA_RE = re.compile(r"#\s*Suppress:\s*Lock-FileAtomic\b")


def walk_prod(roots: Iterable[str]) -> Iterable[str]:
    for root in roots:
        if not os.path.isdir(root):
            continue
        for cur, dirs, files in os.walk(root):
            dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS and not d.startswith(".")]
            for name in files:
                yield os.path.join(cur, name)


def read_text_safely(path: str) -> str:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read()
    except (OSError, UnicodeDecodeError):
        return ""


def normalise(path: str) -> str:
    return path.replace("/", os.sep)


# ---------------------------------------------------------------------------
# Per-file checks
# ---------------------------------------------------------------------------
def check_python_mkstemp(path: str) -> List[str]:
    rel = normalise(path)
    if rel in PY_MKSTEMP_ALLOWLIST:
        return []
    src = read_text_safely(path)
    if not src:
        return []
    out: List[str] = []
    for ln_i, ln in enumerate(src.splitlines(), start=1):
        code = ln.split("#", 1)[0]
        if PY_MKSTEMP_RE.search(code) and not PY_NOQA_RE.search(ln):
            out.append(
                f"{rel}:{ln_i}: tempfile.mkstemp outside the canonical "
                f"atomic helper -- use core.atomic_io.atomic_write_json "
                f"(suppress with `# noqa: SC2_ATOMIC_FS` if intentional)"
            )
    return out


def check_node_open_wx(path: str) -> List[str]:
    rel = normalise(path)
    if rel in NODE_OPEN_WX_ALLOWLIST:
        return []
    src = read_text_safely(path)
    if not src:
        return []
    out: List[str] = []
    lines = src.splitlines()
    for ln_i, ln in enumerate(lines, start=1):
        # Strip line-leading and trailing comments to avoid false hits.
        stripped = ln.split("//", 1)[0]
        if stripped.lstrip().startswith("*"):
            continue
        if NODE_OPEN_WX_RE.search(stripped) and not NODE_NOQA_RE.search(ln):
            # Also tolerate the previous line carrying the suppress.
            prev = lines[ln_i - 2] if ln_i >= 2 else ""
            if NODE_NOQA_RE.search(prev):
                continue
            out.append(
                f"{rel}:{ln_i}: fs.openSync(*, 'w' or 'wx') outside the "
                f"canonical helper -- delegate to "
                f"lib/atomic-fs.js atomicWrite{{Json,String,Buffer}} "
                f"(suppress with `// eslint-disable-next-line sc2-atomic-fs`)"
            )
    return out


def check_powershell_data_write(path: str) -> List[str]:
    rel = normalise(path)
    if rel in PS_DATA_WRITE_ALLOWLIST:
        return []
    src = read_text_safely(path)
    if not src:
        return []
    out: List[str] = []
    for ln_i, ln in enumerate(src.splitlines(), start=1):
        code = ln.split("#", 1)[0]
        if not PS_DATA_PATH_HINT_RE.search(code):
            continue
        if PS_DATA_WRITE_RE.search(code) and not PS_NOQA_RE.search(ln):
            out.append(
                f"{rel}:{ln_i}: PowerShell write against data\\*.json "
                f"outside lib/Lock-FileAtomic.ps1 -- wrap the write "
                f"in Lock-FileAtomic + Write-FileAtomic "
                f"(suppress with `# Suppress: Lock-FileAtomic`)"
            )
    return out


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------
def main(argv: List[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--paths", nargs="*", default=list(PROD_ROOTS))
    ap.add_argument("--verbose", "-v", action="store_true")
    args = ap.parse_args(argv)

    violations: List[str] = []
    files_checked = 0
    for path in walk_prod(args.paths):
        if path.endswith(".py"):
            files_checked += 1
            violations.extend(check_python_mkstemp(path))
        elif path.endswith(".js") or path.endswith(".mjs") or path.endswith(".cjs"):
            files_checked += 1
            violations.extend(check_node_open_wx(path))
        elif path.endswith(".ps1") or path.endswith(".psm1"):
            files_checked += 1
            violations.extend(check_powershell_data_write(path))

    if violations:
        print("Stage 7 invariants check: VIOLATIONS")
        for v in violations:
            print(f"  {v}")
        print()
        print(
            f"({len(violations)} violation(s) across {files_checked} files scanned.)"
        )
        print("See docs/STAGE_DATA_INTEGRITY_ROADMAP.md Section 7 for the rule.")
        return 1

    if args.verbose:
        print(
            f"Stage 7 invariants check: clean "
            f"({files_checked} files scanned)."
        )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
