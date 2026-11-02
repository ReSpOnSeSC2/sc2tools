"""Git checkout attributes preserve the pinned resource bytes on Windows."""
from pathlib import Path
import subprocess

import pytest


def test_resource_checkout_attributes_keep_notice_manifest_lf_and_replay_binary():
    root = Path(__file__).resolve().parents[3]
    prefix = "apps/agent/sc2tools_agent/resources/support/"
    paths = tuple(prefix + name for name in ("sc2reader-LICENSE.txt", "manifest.json", "diagnostic.SC2Replay"))
    result = subprocess.run(["git", "--no-optional-locks", "-C", str(root), "check-attr", "text", "eol", "--", *paths],
        capture_output=True, text=True, check=False)
    if result.returncode:
        pytest.skip("Git checkout metadata is unavailable in this installed-source test environment")
    values = {}
    for line in result.stdout.splitlines():
        path, attribute, value = line.rsplit(": ", 2)
        values[path, attribute] = value
    assert values[paths[0], "text"] == values[paths[1], "text"] == "set"
    assert values[paths[0], "eol"] == values[paths[1], "eol"] == "lf"
    assert values[paths[2], "text"] == "unset"
