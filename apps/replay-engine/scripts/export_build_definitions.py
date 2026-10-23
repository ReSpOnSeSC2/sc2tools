"""Export the engine's build-label catalog as JSON for the web app.

The web's /definitions page lists every label the classifier can emit.
Its data file, ``apps/web/lib/build-definitions.generated.json``, is built
from this export by ``apps/web/scripts/gen-build-definitions.mjs``
(``npm run definitions:gen``), so a label added to
``core/build_definitions.py`` reaches the web by re-running that script.

Output (stdout, or the path given as the only argument)::

    {
      "definitions": [{"name": "Zerg - 12 Pool", "description": "..."}, ...],
      "eightWorkerNames": {"Zerg - 12 Pool": "Zerg - 8 Pool", ...}
    }

``definitions`` keeps ``BUILD_DEFINITIONS`` order. ``eightWorkerNames``
maps a label to the name it carries on the 8-worker patch 5.0.16.

Usage (from apps/replay-engine)::

    python scripts/export_build_definitions.py [out.json]

Exit codes: 0 on success, 1 on usage error.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Dict, List

ENGINE_ROOT = Path(__file__).resolve().parent.parent
if str(ENGINE_ROOT) not in sys.path:
    sys.path.insert(0, str(ENGINE_ROOT))

# Data-only module: importing it pulls in no replay or UI dependencies.
from core.build_definitions import (  # noqa: E402
    BUILD_DEFINITIONS,
    EIGHT_WORKER_BUILD_NAMES,
)


def export_payload() -> Dict[str, object]:
    """Return the catalog in the export shape.

    Example:
        >>> payload = export_payload()
        >>> payload["definitions"][0]["name"] in BUILD_DEFINITIONS
        True
    """
    definitions: List[Dict[str, str]] = [
        {"name": name, "description": description}
        for name, description in BUILD_DEFINITIONS.items()
    ]
    return {
        "definitions": definitions,
        "eightWorkerNames": dict(sorted(EIGHT_WORKER_BUILD_NAMES.items())),
    }


def main(argv: List[str]) -> int:
    if len(argv) > 1:
        print("usage: export_build_definitions.py [out.json]", file=sys.stderr)
        return 1
    # ASCII-only (non-ASCII as \u escapes), so any console encoding works.
    text = json.dumps(export_payload(), ensure_ascii=True, indent=2) + "\n"
    if argv:
        Path(argv[0]).write_text(text, encoding="utf-8")
    else:
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
