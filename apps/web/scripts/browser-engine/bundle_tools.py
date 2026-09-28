"""Build-time helpers that run INSIDE Pyodide for the browser engine bundle.

``scripts/build-browser-engine.mjs`` loads this file into a Pyodide
interpreter (never into the host CPython), so the bytecode it compiles
matches the exact CPython build the browser runs, and nothing is ever
written into the repository.

* :func:`compile_tree` precompiles sources to UNCHECKED-HASH ``.pyc``: zip
  extraction does not restore mtimes, so timestamp ``.pyc`` files would
  always look stale. Sources stay in the bundle because
  ``replay_pipeline._load_sc2ra_*`` checks that ``<module>.py`` exists.
* :func:`write_deterministic_zip` writes sorted entries with fixed
  timestamps and permissions, so identical inputs give identical bytes.
* :func:`activate_bundle` and :func:`smoke_parse` boot the bundle exactly
  like the browser worker and parse one fixture replay.

Example (inside Pyodide)::

    import bundle_tools
    bundle_tools.compile_tree(["/sc2tools/apps"])
    bundle_tools.write_deterministic_zip("/tmp/engine.zip", ["/sc2tools"])
"""

from __future__ import annotations

import compileall
import importlib
import json
import logging
import os
import py_compile
import sys
import zipfile
from typing import Iterable, List

#: Earliest timestamp a zip entry can hold; used for every entry.
ZIP_EPOCH = (1980, 1, 1, 0, 0, 0)
#: Regular file, rw-r--r--, stored in the high 16 bits of external_attr.
REGULAR_FILE_ATTR = 0o100644 << 16
#: "Unix" in the zip central directory (makes external_attr meaningful).
ZIP_CREATE_SYSTEM_UNIX = 3
DEFLATE_LEVEL = 9
QUIET_ERRORS_ONLY = 1


def compile_tree(paths: Iterable[str]) -> None:
    """Compile every ``.py`` under ``paths`` to unchecked-hash ``.pyc``.

    Args:
        paths: Directories and/or single ``.py`` files.

    Raises:
        RuntimeError: A source failed to compile.

    Example:
        >>> compile_tree([])  # no-op
    """
    mode = py_compile.PycInvalidationMode.UNCHECKED_HASH
    ok = True
    for path in paths:
        if os.path.isdir(path):
            ok = compileall.compile_dir(path, quiet=QUIET_ERRORS_ONLY, invalidation_mode=mode, optimize=0) and ok
        else:
            ok = compileall.compile_file(path, quiet=QUIET_ERRORS_ONLY, invalidation_mode=mode, optimize=0) and ok
    if not ok:
        raise RuntimeError("compileall reported a syntax error in the bundle sources")


def collect_files(roots: Iterable[str]) -> List[str]:
    """Absolute paths of every regular file under ``roots``, sorted.

    Example:
        >>> collect_files([])
        []
    """
    found: List[str] = []
    for root in roots:
        if os.path.isfile(root):
            found.append(root)
            continue
        for directory, _dirs, files in os.walk(root):
            found.extend(os.path.join(directory, name) for name in files)
    return sorted(set(found))


def write_deterministic_zip(out_path: str, roots: Iterable[str]) -> str:
    """Zip ``roots`` so the archive unpacks at ``/``; returns a JSON summary.

    Entries are sorted, dated 1980-01-01, marked rw-r--r-- on Unix and
    deflated at level 9, so the same files always give the same bytes.

    Example:
        >>> json.loads(write_deterministic_zip("/tmp/empty.zip", []))["files"]
        0
    """
    files = collect_files(roots)
    raw_bytes = 0
    with zipfile.ZipFile(out_path, "w") as archive:
        for path in files:
            info = zipfile.ZipInfo(path.lstrip("/"), date_time=ZIP_EPOCH)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = ZIP_CREATE_SYSTEM_UNIX
            info.external_attr = REGULAR_FILE_ATTR
            with open(path, "rb") as handle:
                data = handle.read()
            raw_bytes += len(data)
            archive.writestr(info, data, compresslevel=DEFLATE_LEVEL)
    pyc = sum(1 for path in files if path.endswith(".pyc"))
    return json.dumps({"files": len(files), "pyc": pyc, "rawBytes": raw_bytes})


def activate_bundle(sys_path: Iterable[str], module: str) -> None:
    """Make an unpacked bundle importable and import its entry module.

    Mirrors the browser worker: prepend ``sys_path``, refresh the import
    caches, silence sc2reader's logger and import ``module``.

    Example (inside Pyodide, after unpacking engine.zip at "/")::

        activate_bundle(["/sc2tools/apps/agent"], "sc2tools_agent.instant_analysis")
    """
    for entry in reversed(list(sys_path)):
        if entry not in sys.path:
            sys.path.insert(0, entry)
    importlib.invalidate_caches()
    logging.getLogger("sc2reader").setLevel(logging.CRITICAL)
    importlib.import_module(module)


def smoke_parse(module: str, replay_path: str, player_toon: str) -> str:
    """Parse one replay through ``module``; returns a JSON summary.

    Example (inside Pyodide)::

        smoke_parse("sc2tools_agent.instant_analysis", "/tmp/x.SC2Replay", "1-S2-1-267727")
    """
    engine = importlib.import_module(module)
    with open(replay_path, "rb") as handle:
        data = handle.read()
    result = engine.parse_replay_bytes(
        data,
        filename=os.path.basename(replay_path),
        runtime=engine.RuntimeOptions(player_toon=player_toon),
    )
    return json.dumps({
        "ok": result["ok"],
        "errorKind": result.get("errorKind"),
        "gameId": result.get("gameId"),
        "jsonBytes": len(result.get("json") or ""),
    })
