"""Local LIVE Studio discovery and explicit launch; never signs in or starts LIVE."""
from __future__ import annotations

import csv
import io
import os
from pathlib import Path
import re
import subprocess
import sys


def discover_studio():
    if sys.platform != "win32":
        return None
    for variable in ("ProgramFiles", "ProgramFiles(x86)"):
        value = os.environ.get(variable)
        if not value:
            continue
        root = Path(value) / "TikTok LIVE Studio"
        if not root.is_dir():
            continue
        versions = []
        for directory in root.iterdir():
            if directory.is_dir() and re.fullmatch(r"\d+(?:\.\d+){2,3}", directory.name):
                executable = directory / "TikTok LIVE Studio.exe"
                if executable.is_file():
                    versions.append((tuple(int(part) for part in directory.name.split(".")), directory.name, executable))
        version, executable = (None, None)
        if versions:
            _, version, executable = max(versions)
        launcher = root / "TikTok LIVE Studio Launcher.exe"
        if launcher.is_file():
            executable = launcher
        if executable:
            return {"path": executable, "version": version}
    return None


def studio_running():
    if sys.platform != "win32":
        return False
    try:
        result = subprocess.run([str(Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "tasklist.exe"),
                                 "/FO", "CSV", "/NH"], capture_output=True, text=True, timeout=3,
                                creationflags=subprocess.CREATE_NO_WINDOW, check=True)
        return any(row and row[0].casefold() == "tiktok live studio.exe" for row in csv.reader(io.StringIO(result.stdout)))
    except (OSError, subprocess.SubprocessError):
        return None


def launch_studio(path):
    # This is the user's explicit Open LIVE Studio action, not background startup.
    subprocess.Popen([str(path)], cwd=str(path.parent), shell=False)


class TikTokStudio:
    def __init__(self, *, discover=discover_studio, running=studio_running, launch=launch_studio):
        self.discover = discover
        self.running = running
        self.launch_process = launch

    def status(self):
        try:
            installation = self.discover()
            running = self.running()
        except (OSError, ValueError):
            installation, running = None, None
        return {"installed": bool(installation), "running": running,
                "version": installation.get("version") if installation else None}

    def launch(self):
        try:
            installation = self.discover()
            if not installation:
                raise ValueError("Install TikTok LIVE Studio from TikTok, then check setup again.")
            if self.running() is not True:
                self.launch_process(installation["path"])
            return self.status()
        except (OSError, subprocess.SubprocessError):
            raise ValueError("LIVE Studio could not open. Launch it from the Windows Start menu, then check setup.") from None
