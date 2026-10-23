"""The web's /definitions data follows this engine's label catalog.

``scripts/export_build_definitions.py`` exports ``BUILD_DEFINITIONS``; the
web turns that export into ``apps/web/lib/build-definitions.generated.json``
(``npm run definitions:gen``). These tests fail when a label or its
description changes here without re-running that script.
"""
import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest

from core.build_definitions import BUILD_DEFINITIONS, EIGHT_WORKER_BUILD_NAMES

ENGINE_ROOT = Path(__file__).resolve().parent.parent
EXPORT_SCRIPT = ENGINE_ROOT / "scripts" / "export_build_definitions.py"
WEB_GENERATED = (
    ENGINE_ROOT.parent / "web" / "lib" / "build-definitions.generated.json"
)
REGENERATE = "run `npm run definitions:gen` in apps/web"

# scripts/ is not a package; load the CLI module from its file.
_spec = importlib.util.spec_from_file_location("export_build_definitions", EXPORT_SCRIPT)
_export = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_export)
export_payload = _export.export_payload


def test_export_lists_every_label_once_with_its_description():
    payload = export_payload()
    names = [entry["name"] for entry in payload["definitions"]]
    assert names == list(BUILD_DEFINITIONS)
    for entry in payload["definitions"]:
        assert entry["description"] == BUILD_DEFINITIONS[entry["name"]]
    assert payload["eightWorkerNames"] == dict(sorted(EIGHT_WORKER_BUILD_NAMES.items()))


def test_cli_prints_the_same_payload_as_ascii_json():
    out = subprocess.run(
        [sys.executable, str(EXPORT_SCRIPT)],
        cwd=ENGINE_ROOT,
        capture_output=True,
        check=True,
    ).stdout
    out.decode("ascii")  # any console encoding can carry it
    assert json.loads(out) == export_payload()


@pytest.mark.skipif(not WEB_GENERATED.exists(), reason="apps/web is not checked out")
def test_web_generated_catalog_matches_the_engine():
    generated = json.loads(WEB_GENERATED.read_text(encoding="utf-8"))
    by_name = {entry["name"]: entry for entry in generated["definitions"]}
    assert sorted(by_name) == sorted(BUILD_DEFINITIONS), REGENERATE
    for name, description in BUILD_DEFINITIONS.items():
        entry = by_name[name]
        assert entry["description"] == description.strip(), f"{name}: {REGENERATE}"
        assert entry.get("eightWorkerName") == EIGHT_WORKER_BUILD_NAMES.get(name), (
            f"{name}: {REGENERATE}"
        )
