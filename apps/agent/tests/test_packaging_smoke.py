"""The frozen GUI diagnostic must fail closed before agent/service startup."""
from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

import pytest

from sc2tools_agent import __main__ as entrypoint
from sc2tools_agent import packaging_smoke


@pytest.mark.parametrize("result", [0, 1])
def test_packaging_mode_never_calls_agent_even_on_failure(tmp_path, monkeypatch, result):
    report = tmp_path / "report.json"
    monkeypatch.setenv(packaging_smoke.SMOKE_REPORT_ENV, str(report))
    calls = []
    monkeypatch.setattr(packaging_smoke, "run_gui_smoke", lambda path: calls.append(path) or result)
    def forbidden():
        raise AssertionError("Packaging mode must not bootstrap the agent.")
    monkeypatch.setattr(entrypoint, "run_agent", forbidden)
    assert entrypoint.main() == result
    assert calls == [str(report)]


def test_normal_entrypoint_still_runs_agent(monkeypatch):
    monkeypatch.delenv(packaging_smoke.SMOKE_REPORT_ENV, raising=False)
    monkeypatch.setattr(entrypoint, "run_agent", lambda: 7)
    assert entrypoint.main() == 7


def test_qt_import_failure_is_nonzero_and_never_reports_success(tmp_path, monkeypatch):
    destination = tmp_path / "report.json"
    def unavailable(report):
        report["stage"] = "qt_import"
        raise ImportError("private DLL path and secret must not be reported")
    monkeypatch.setattr(packaging_smoke, "_exercise_gui", unavailable)
    monkeypatch.setenv("QT_QPA_PLATFORM", "previous-platform")
    assert packaging_smoke.run_gui_smoke(str(destination)) == 1
    report = json.loads(destination.read_text(encoding="utf-8"))
    assert report["ok"] is False
    assert report["stage"] == "qt_import"
    assert report["error_type"] == "ImportError"
    assert "secret" not in str(report)
    assert os.environ["QT_QPA_PLATFORM"] == "previous-platform"


def test_real_offscreen_window_never_reads_state_starts_threads_or_uses_network(tmp_path):
    pytest.importorskip("PySide6.QtWidgets")
    destination = tmp_path / "report.json"
    environment = os.environ.copy()
    environment[packaging_smoke.SMOKE_REPORT_ENV] = str(destination)
    environment["SC2TOOLS_STATE_DIR"] = str(tmp_path / "forbidden-user-state")
    environment["PYTHONPATH"] = str(Path(__file__).resolve().parents[1])
    script = """
import socket
import threading
from sc2tools_agent import __main__, runner
from sc2tools_agent.ui import gui
def forbidden(*args, **kwargs):
    raise AssertionError('No bootstrap, background service or network is allowed.')
__main__.run_agent = forbidden
runner._bootstrap = forbidden
runner._build_stream_service = forbidden
gui.can_use_gui = forbidden
socket.socket.connect = forbidden
threading.Thread.start = forbidden
raise SystemExit(__main__.main())
"""
    result = subprocess.run([sys.executable, "-c", script], cwd=tmp_path,
                            env=environment, capture_output=True, text=True, timeout=15)
    assert result.returncode == 0, result.stderr
    report = json.loads(destination.read_text(encoding="utf-8"))
    assert report["ok"] is True
    assert report["qt_platform"] == "offscreen"
    assert report["page_count"] == 5
    assert report["streams_painted"] is True
    assert set(tmp_path.iterdir()) == {destination}


def test_pyinstaller_failure_restores_path_and_excludes_foreign_dll_directories(tmp_path):
    powershell = shutil.which("pwsh")
    if os.name != "nt" or powershell is None:
        pytest.skip("The Windows packaging PATH check requires PowerShell 7.")
    environment = os.environ.copy()
    foreign_directory = str(tmp_path / "foreign-poppler-dlls")
    environment["PATH"] = foreign_directory + os.pathsep + environment.get("PATH", "")
    environment["SC2TOOLS_TEST_BUILD_SCRIPT"] = str(Path(__file__).resolve().parents[1] / "packaging" / "build-installer.ps1")
    environment["SC2TOOLS_TEST_BASE_PYTHON"] = sys.base_prefix
    environment["SC2TOOLS_TEST_FOREIGN_DLLS"] = foreign_directory
    script = r"""
$ErrorActionPreference = 'Stop'
$ast = [Management.Automation.Language.Parser]::ParseFile($env:SC2TOOLS_TEST_BUILD_SCRIPT, [ref]$null, [ref]$null)
$step = $ast.FindAll({ param($node)
    $node -is [Management.Automation.Language.CommandAst] -and
    $node.CommandElements.Count -ge 3 -and
    $node.CommandElements[0].Extent.Text -eq 'Invoke-Step' -and
    $node.CommandElements[1].Value -eq 'Running PyInstaller'
}, $true)[0]
$AgentRoot = (Get-Location).Path
$VenvDir = Join-Path $AgentRoot 'test-build-venv'
$VenvPython = 'MockBuildPython'
$Spec = 'unused.spec'
$savedPath = $env:PATH
function MockBuildPython {
    if ($args[0] -eq '-c') {
        $global:LASTEXITCODE = 0
        $env:SC2TOOLS_TEST_BASE_PYTHON
    } else {
        $script:collectedPath = $env:PATH
        $global:LASTEXITCODE = 37
        throw 'Simulated PyInstaller failure'
    }
}
try { & $step.CommandElements[2].ScriptBlock.GetScriptBlock() }
catch { $failureExercised = $_.Exception.Message -eq 'Simulated PyInstaller failure' }
$expectedPath = @(
    (Join-Path $VenvDir 'Scripts'), $env:SC2TOOLS_TEST_BASE_PYTHON,
    (Join-Path $env:SystemRoot 'System32'), $env:SystemRoot
) -join [IO.Path]::PathSeparator
@{
    failure_exercised = $failureExercised
    caller_path_restored = ($env:PATH -eq $savedPath)
    path_isolated = ($script:collectedPath -eq $expectedPath)
    foreign_dlls_excluded = (-not $script:collectedPath.Contains($env:SC2TOOLS_TEST_FOREIGN_DLLS))
} | ConvertTo-Json -Compress
exit 0
"""
    result = subprocess.run([powershell, "-NoProfile", "-NonInteractive", "-Command", script],
                            cwd=tmp_path, env=environment, capture_output=True, text=True, timeout=15)
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == {
        "failure_exercised": True, "caller_path_restored": True,
        "path_isolated": True, "foreign_dlls_excluded": True,
    }
