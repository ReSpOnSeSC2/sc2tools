"""The version-check workflow's rule for the agent version the website names.

The website shows ``FALLBACK_LATEST_AGENT_VERSION`` as the version to install
before release metadata loads. It must be the package version or the release
before it, so the site never names an agent that is still being prepared.
The workflow's own script runs here against fixture versions.
"""
from pathlib import Path
import subprocess
import sys
import textwrap

import pytest

REPOSITORY = Path(__file__).resolve().parents[3]
WORKFLOW = REPOSITORY / ".github" / "workflows" / "version-check.yml"
# Read by the same script for its engine checks; copied as committed.
ENGINE_FILES = ("apps/replay-engine/VERSION", "apps/replay-engine/__init__.py",
                "apps/web/lib/instant/engineVersion.ts", "apps/web/package.json")


def _check_script():
    lines = WORKFLOW.read_text(encoding="utf-8").splitlines()
    start = next(index for index, line in enumerate(lines) if line.strip() == "python3 - <<'PY'")
    end = next(index for index in range(start + 1, len(lines)) if lines[index].strip() == "PY")
    return textwrap.dedent("\n".join(lines[start + 1:end])) + "\n"


def _check(root, tmp_path):
    script = tmp_path / "version_check.py"
    script.write_text(_check_script(), encoding="utf-8")
    return subprocess.run([sys.executable, str(script)], cwd=root, capture_output=True, text=True, timeout=60)


def _fixture_check(tmp_path, *, package, fallback, changelog):
    root = tmp_path / "repository"
    files = {name: (REPOSITORY / name).read_bytes() for name in ENGINE_FILES}
    sections = "".join(f"## {version}\n\n### Added\n- Fixture notes.\n\n" for version in changelog)
    files.update({
        "apps/agent/sc2tools_agent/__init__.py": f'__version__ = "{package}"\n'.encode(),
        "apps/web/lib/agentNotice.ts": f'export const FALLBACK_LATEST_AGENT_VERSION = "{fallback}";\n'.encode(),
        "apps/agent/CHANGELOG.md": ("# Changelog\n\n" + sections).encode(),
    })
    for name, content in files.items():
        target = root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
    return _check(root, tmp_path)


def test_the_committed_versions_pass(tmp_path):
    result = _check(REPOSITORY, tmp_path)
    assert result.returncode == 0, result.stdout + result.stderr


def test_a_release_commit_names_the_package_version(tmp_path):
    result = _fixture_check(tmp_path, package="0.25.0", fallback="0.25.0", changelog=["0.25.0", "0.24.11"])
    assert result.returncode == 0, result.stdout + result.stderr
    assert "agree on 0.25.0" in result.stdout


def test_a_version_in_preparation_leaves_the_website_on_the_release_before_it(tmp_path):
    result = _fixture_check(tmp_path, package="0.25.0", fallback="0.24.11", changelog=["0.25.0", "0.24.11", "0.24.10"])
    assert result.returncode == 0, result.stdout + result.stderr
    assert "0.24.11 is the release before agent 0.25.0" in result.stdout


@pytest.mark.parametrize("package,fallback,changelog", [
    # Ahead of the package: the site would name an agent nobody can install.
    ("0.24.11", "0.25.0", ["0.24.11", "0.24.10"]),
    ("0.24.11", "0.25.0", ["0.25.0", "0.24.11", "0.24.10"]),
    # More than one release behind.
    ("0.25.0", "0.24.10", ["0.25.0", "0.24.11", "0.24.10"]),
    # Without a changelog section for the package there is no release before it to fall back to.
    ("0.25.0", "0.24.11", ["0.24.11", "0.24.10"]),
    ("0.25.0", "0.24.11", []),
])
def test_any_other_fallback_is_version_drift(tmp_path, package, fallback, changelog):
    result = _fixture_check(tmp_path, package=package, fallback=fallback, changelog=changelog)
    assert result.returncode != 0
    assert f"agent version drift -- package {package}, web fallback {fallback}" in result.stdout + result.stderr
