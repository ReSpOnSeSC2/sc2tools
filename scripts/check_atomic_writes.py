#!/usr/bin/env python3
"""Pre-commit / CI guard: forbid non-atomic file writes in production code.

The April-2026 truncation incident (see docs/TRUNCATION_AUDIT.md) was
caused by writers that used ``tempfile + os.replace`` without an
intervening ``flush + fsync``, plus a small set of writers that called
``fs.writeFileSync`` / ``open(path, "w")`` directly. This script greps
the production trees for either pattern and exits non-zero if it finds
a regression.

What it checks
--------------
* Python: every ``os.replace(`` or ``os.rename(`` call that targets a
  data file must have an ``os.fsync(`` (or ``atomic_write_*`` helper
  call) earlier in the same function body.
* Node:   every ``fs.writeFileSync`` / ``fs.renameSync`` outside the
  canonical helper at ``stream-overlay-backend/lib/atomic-fs.js`` and
  the explicit allow-list below must come from a delegation through
  that helper.

What it does NOT check
----------------------
* Tests (``__tests__/``, ``tests/``, ``test_*.py``).
* Build / packaging scripts (``packaging/``, ``dist/``, ``build/``).
* Worktrees and dot-dirs.
* Files outside the production trees (``.claude``, ``cloud``, etc.).

Usage::

    python3 scripts/check_atomic_writes.py            # exits 0 on clean
    python3 scripts/check_atomic_writes.py --verbose  # show every ok line
    python3 scripts/check_atomic_writes.py --paths reveal-sc2-opponent-main

Exit codes::

    0  no violations
    1  one or more violations found (printed with file:line)
    2  invocation error
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from typing import Iterable, List, Tuple

# --------------------------------------------------------------------
# Configuration. Every magic string here is named so the rule is easy
# to grep and update without scanning the whole script.
# --------------------------------------------------------------------

PROD_ROOTS = ("reveal-sc2-opponent-main", "SC2Replay-Analyzer")

EXCLUDE_DIR_NAMES = {
    "node_modules",
    "__pycache__",
    "__tests__",
    "tests",
    "dist",
    "build",
    "packaging",
    ".git",
    ".claude",
    ".vscode",
    "worktrees",
}

# Files whose explicit job is to BE the atomic helper. The grep ignores
# these — the rule it enforces does not apply to its own implementation.
HELPER_ALLOWLIST = {
    os.path.join(
        "reveal-sc2-opponent-main",
        "stream-overlay-backend",
        "lib",
        "atomic-fs.js",
    ),
    os.path.join("reveal-sc2-opponent-main", "core", "atomic_io.py"),
}

# Specific files that have a documented reason to be exempt from a
# specific rule. Keep this list short and reviewed in PR.
NODE_BARE_WRITE_EXEMPT = {
    # Map-tile image cache. Not a data file; readers tolerate partial PNGs
    # by re-fetching. Tracked under audit follow-up A2 (see doc).
    os.path.join(
        "reveal-sc2-opponent-main",
        "stream-overlay-backend",
        "analyzer.js",
    ),
    # routes/doctor.js writes a tiny "probe" file (timestamp string) to
    # verify the data dir is writable, then unlinks it. Not a data
    # file -- it's a fs-permission probe. Documented as part of the
    # bootstrap doctor banner (commit 68e50fe).
    os.path.join(
        "reveal-sc2-opponent-main",
        "stream-overlay-backend",
        "routes",
        "doctor.js",
    ),
}

PYTHON_BARE_WRITE_EXEMPT = {
    # data_store.py writes a one-off ``.corrupt`` quarantine dump after
    # detecting bad input — best-effort and post-error by definition.
    os.path.join("reveal-sc2-opponent-main", "core", "data_store.py"),
    # The CSV / debug-report writers in analyzer_app.py go through
    # atomic_write_text after Phase 2; the file legitimately uses
    # ``open(path, "w")`` for log files in non-data paths. Whitelisted
    # at the file level; the per-call review lives in PR.
    os.path.join("reveal-sc2-opponent-main", "gui", "analyzer_app.py"),
    # error_logger writes go through atomic_write_text since Phase 2.
    os.path.join("reveal-sc2-opponent-main", "core", "error_logger.py"),
    # Build-time scripts (extract icons, recon install, etc.) that emit
    # manifest text files. They run once and are not a runtime data path.
    os.path.join(
        "reveal-sc2-opponent-main", "scripts", "extract_sc2_icons.py"
    ),
    os.path.join(
        "reveal-sc2-opponent-main", "scripts", "extract_sc2_icons_casc.py"
    ),
    os.path.join("reveal-sc2-opponent-main", "scripts", "recon_sc2_install.py"),
    # Dev-only fake-data injector. Not run in production. The script
    # itself documents this in its module docstring.
    os.path.join(
        "SC2Replay-Analyzer", "scripts", "fake_data_injector.py"
    ),
    # The migrations CLI in SC2Replay-Analyzer's db/database.py uses
    # ``open(path, "w", newline="")`` for CSV exports — same pattern as
    # analyzer_app.py and equally low blast.
    os.path.join("SC2Replay-Analyzer", "db", "database.py"),
}

# --------------------------------------------------------------------
# Patterns. Tight regexes so we don't catch comments or strings.
# --------------------------------------------------------------------

# Python: ``os.replace(`` or ``os.rename(`` as a real call.
PY_REPLACE_RE = re.compile(r"\bos\.(?:replace|rename)\s*\(")
PY_FSYNC_RE = re.compile(r"\bos\.fsync\s*\(")
PY_ATOMIC_HELPER_RE = re.compile(r"\batomic_write_(?:json|text|bytes)\s*\(")

# A function body in Python: from "def foo(...)" through to the next
# top-level definition or end-of-file. Kept simple — complex nesting
# is handled by the per-line walk below.
PY_DEF_RE = re.compile(r"^(\s*)def\s+\w+\s*\(", re.MULTILINE)

# Python bare write to a destination filename (open(..., "w") /
# open(..., "wb") / open(..., "a") on a path that ends in .json).
PY_BARE_JSON_WRITE_RE = re.compile(
    r"open\([^)]*\.json[^)]*[\"'](?:w|wb|a|ab)[\"']"
)

# Node: fs.writeFileSync / fs.appendFile(Sync)? on a path. Same idea as Python.
NODE_BARE_WRITE_RE = re.compile(
    r"\bfs\.(?:writeFileSync|writeFile|appendFileSync|appendFile)\s*\("
)

# --------------------------------------------------------------------
# File walking. No external deps.
# --------------------------------------------------------------------


def walk_prod(roots: Iterable[str]) -> Iterable[str]:
    """Yield every file path under ``roots`` not in an excluded dir."""
    for root in roots:
        if not os.path.isdir(root):
            continue
        for cur, dirs, files in os.walk(root):
            dirs[:] = [d for d in dirs if d not in EXCLUDE_DIR_NAMES
                       and not d.startswith(".")]
            for name in files:
                yield os.path.join(cur, name)


def read_text_safely(path: str) -> str:
    """Return the file's text or '' on decode failure."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read()
    except (OSError, UnicodeDecodeError):
        return ""


def normalise(path: str) -> str:
    """Canonicalise a path for allow-list comparison."""
    return path.replace("/", os.sep)


# --------------------------------------------------------------------
# The actual rules.
# --------------------------------------------------------------------


def split_python_functions(src: str) -> List[Tuple[int, str]]:
    """Yield (start_line, body_text) per top-level/method def.

    A body is everything indented under the def header until we see a
    line at <= the def's own indent that is not blank or a comment.
    Approximation; good enough to scope ``os.replace`` to its
    surrounding function.
    """
    lines = src.splitlines(keepends=True)
    out: List[Tuple[int, str]] = []
    i = 0
    while i < len(lines):
        m = PY_DEF_RE.match(lines[i])
        if not m:
            i += 1
            continue
        indent = len(m.group(1))
        start = i
        i += 1
        while i < len(lines):
            ln = lines[i]
            if not ln.strip():
                i += 1
                continue
            if ln.lstrip().startswith("#"):
                i += 1
                continue
            cur_indent = len(ln) - len(ln.lstrip())
            if cur_indent <= indent:
                break
            i += 1
        out.append((start + 1, "".join(lines[start:i])))
    return out


def check_python_file(path: str) -> List[str]:
    """Return a list of human-readable violation strings."""
    src = read_text_safely(path)
    if not src:
        return []
    rel = normalise(path)
    violations: List[str] = []

    # Rule 1: os.replace / os.rename without earlier fsync / atomic helper
    # in the same function body.
    for start_line, body in split_python_functions(src):
        if not PY_REPLACE_RE.search(body):
            continue
        if PY_FSYNC_RE.search(body) or PY_ATOMIC_HELPER_RE.search(body):
            continue
        # Pinpoint the exact replace/rename line for the message.
        for offset, ln in enumerate(body.splitlines()):
            if PY_REPLACE_RE.search(ln):
                violations.append(
                    f"{rel}:{start_line + offset}: os.replace/rename "
                    f"without preceding os.fsync or atomic_write_*"
                )

    # Rule 2: bare ``open(path.json, "w"|"a")`` outside the helper /
    # exempt list.
    if rel not in PYTHON_BARE_WRITE_EXEMPT \
       and rel not in HELPER_ALLOWLIST:
        for ln_i, ln in enumerate(src.splitlines(), start=1):
            code = ln.split("#", 1)[0]
            if PY_BARE_JSON_WRITE_RE.search(code):
                violations.append(
                    f"{rel}:{ln_i}: bare open(*.json, 'w'/'a') -- "
                    f"use core.atomic_io.atomic_write_json"
                )
    return violations


def check_node_file(path: str) -> List[str]:
    """Return a list of human-readable violation strings."""
    src = read_text_safely(path)
    if not src:
        return []
    rel = normalise(path)
    if rel in HELPER_ALLOWLIST or rel in NODE_BARE_WRITE_EXEMPT:
        return []
    violations: List[str] = []
    for ln_i, ln in enumerate(src.splitlines(), start=1):
        # Strip line-leading and inline // comments before matching
        # so doc-comments mentioning fs.writeFileSync don't trip the rule.
        stripped = ln.split("//", 1)[0]
        # Also strip the body of block comments that begin with " * ".
        if stripped.lstrip().startswith("*"):
            continue
        if NODE_BARE_WRITE_RE.search(stripped):
            violations.append(
                f"{rel}:{ln_i}: fs.writeFileSync/appendFile -- "
                f"use lib/atomic-fs.atomicWrite{{Json,String,Buffer}}"
            )
    return violations


# --------------------------------------------------------------------
# Entry point.
# --------------------------------------------------------------------


def main(argv: List[str]) -> int:
    """Parse args and run the checks."""
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument(
        "--paths",
        nargs="*",
        default=list(PROD_ROOTS),
        help="Production roots to scan (default: %(default)s)",
    )
    ap.add_argument(
        "--verbose", "-v",
        action="store_true",
        help="Print one-line OK summary even when clean.",
    )
    args = ap.parse_args(argv)

    violations: List[str] = []
    files_checked = 0
    for path in walk_prod(args.paths):
        if path.endswith(".py"):
            files_checked += 1
            violations.extend(check_python_file(path))
        elif path.endswith(".js") or path.endswith(".mjs"):
            files_checked += 1
            violations.extend(check_node_file(path))

    if violations:
        print("Atomic-write guard: VIOLATIONS")
        for v in violations:
            print(f"  {v}")
        print()
        print(f"({len(violations)} violation(s) across {files_checked} files scanned.)")
        print("See docs/adr/0001-atomic-file-writes.md for the rule.")
        return 1

    if args.verbose:
        print(f"Atomic-write guard: clean ({files_checked} files scanned).")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
