"""Drift-check for the shared analytics modules.

The desktop apps and the SPA backend rely on two analytics files that
must stay byte-identical between the two repos:

    SC2Replay-Analyzer/analytics/timing_catalog.py
    reveal-sc2-opponent-main/analytics/timing_catalog.py

    SC2Replay-Analyzer/analytics/opponent_profiler.py
    reveal-sc2-opponent-main/analytics/opponent_profiler.py

Aside from the top-of-file KEEP-IN-SYNC notice block (which lists the
two paths and is allowed to differ between repos), every byte must
match. This script prints a unified diff for any pair that drifts and
exits non-zero so a CI pipeline can block the merge.

Usage:
    python scripts/check_shared_modules.py

Exit codes:
    0 - all shared modules in sync
    1 - drift detected (diff printed)
    2 - missing file in one or both repos
"""

from __future__ import annotations

import difflib
import sys
from pathlib import Path
from typing import List, Tuple


SHARED_BASENAMES: List[str] = [
    "analytics/timing_catalog.py",
    "analytics/opponent_profiler.py",
]


def _resolve_repo_pair() -> Tuple[Path, Path]:
    """Locate both repos relative to this script's location.

    Looks two levels up (scripts/ -> repo -> SC2TOOLS) for the sibling
    repo. Falls back to absolute paths under ``C:\\SC2TOOLS`` (the
    canonical desktop install layout) if the relative lookup fails.
    Returns ``(repo_a, repo_b)`` in alphabetical order so the output
    is deterministic.
    """
    here = Path(__file__).resolve()
    this_repo = here.parent.parent          # scripts/<file> -> repo
    parent = this_repo.parent               # SC2TOOLS/

    candidates = {
        "SC2Replay-Analyzer":      parent / "SC2Replay-Analyzer",
        "reveal-sc2-opponent-main": parent / "reveal-sc2-opponent-main",
    }
    found = {name: p for name, p in candidates.items() if p.is_dir()}
    if len(found) < 2:
        # Fallback: absolute Windows-style desktop paths used by the
        # in-house installs. POSIX systems will hit the relative lookup
        # above instead.
        for name in candidates:
            abs_path = Path(f"C:/SC2TOOLS/{name}")
            if abs_path.is_dir():
                found[name] = abs_path

    if "SC2Replay-Analyzer" not in found or "reveal-sc2-opponent-main" not in found:
        print(
            "FAIL: could not locate both repos. "
            "Expected siblings under the parent of this script's repo.",
            file=sys.stderr,
        )
        sys.exit(2)

    return (
        found["SC2Replay-Analyzer"].resolve(),
        found["reveal-sc2-opponent-main"].resolve(),
    )


# The KEEP-IN-SYNC banner at the top of each shared module references
# the file's own absolute path -- which is necessarily different between
# the two repos. We strip the banner before comparing so the path
# difference doesn't trip the drift check. The banner is the first
# triple-quoted docstring in the file; everything *after* the closing
# triple-quote must match.
def _strip_module_docstring(text: str) -> str:
    # Find the first """ ... """ block. Tolerates leading whitespace /
    # blank lines so the regex isn't required.
    start_quote = '"""'
    first = text.find(start_quote)
    if first == -1:
        return text  # no docstring at all - nothing to strip
    end = text.find(start_quote, first + len(start_quote))
    if end == -1:
        return text  # malformed docstring - leave alone
    after = end + len(start_quote)
    # Drop a single trailing newline so the comparison body starts at
    # the same column on both sides.
    if after < len(text) and text[after] == "\n":
        after += 1
    return text[after:]


def _diff_pair(label: str, a_path: Path, b_path: Path) -> bool:
    """Return True on drift (and print a unified diff). False if in sync."""
    if not a_path.is_file():
        print(f"FAIL: {a_path} missing", file=sys.stderr)
        return True
    if not b_path.is_file():
        print(f"FAIL: {b_path} missing", file=sys.stderr)
        return True
    a_text = a_path.read_text(encoding="utf-8")
    b_text = b_path.read_text(encoding="utf-8")
    a_body = _strip_module_docstring(a_text)
    b_body = _strip_module_docstring(b_text)
    if a_body == b_body:
        return False
    # Drift detected - print a context-3 unified diff.
    diff = difflib.unified_diff(
        a_body.splitlines(keepends=True),
        b_body.splitlines(keepends=True),
        fromfile=str(a_path),
        tofile=str(b_path),
        n=3,
    )
    print(f"\nDRIFT: {label}")
    sys.stdout.writelines(diff)
    return True


def main() -> int:
    repo_a, repo_b = _resolve_repo_pair()
    print(f"Comparing:\n  A = {repo_a}\n  B = {repo_b}\n")

    drifted = False
    for rel in SHARED_BASENAMES:
        a = repo_a / rel
        b = repo_b / rel
        if _diff_pair(rel, a, b):
            drifted = True
        else:
            print(f"  OK  {rel}")

    if drifted:
        print(
            "\nFAIL: shared modules drifted. "
            "Copy the canonical version into both repos before merging.",
            file=sys.stderr,
        )
        return 1

    print("\nOK: all shared modules in sync.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
