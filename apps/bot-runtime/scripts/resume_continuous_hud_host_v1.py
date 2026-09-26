"""One authorized continuous learner entrypoint for a separate Windows host.

The caller launches this with Win32_Process.Create and CREATE_NO_WINDOW outside
the terminal job. It does not change training code, checkpoints, or STOP files.
"""
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import runpy
import sys

import psutil

ROOT = Path(__file__).resolve().parents[1]
RUN = ROOT / "runs/build-order-hud-v1/fit-v1"
HERE = ROOT / "runs/build-order-hud-host-v1"


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def main():
    os.chdir(ROOT)
    HERE.mkdir(exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    sys.stdout = (HERE / f"{stamp}.stdout.log").open("x", encoding="utf-8", buffering=1)
    sys.stderr = (HERE / f"{stamp}.stderr.log").open("x", encoding="utf-8", buffering=1)
    paths = [ROOT / "STOP", RUN / "STOP",
             ROOT / "runs/build-order-prior-v1/fit619-v1/STOP",
             ROOT / "runs/own-hud-feature-extraction-v1/data-v1/STOP",
             ROOT / "runs/player-expansion-contract-review-v1/scoped619-v1/sequences-v2/STOP"]
    if any(path.exists() for path in paths):
        raise InterruptedError("STOP respected by persistent host")
    previous = json.loads((RUN / "status.json").read_text())
    try:
        prior = psutil.Process(previous["pid"])
        if prior.is_running() and abs(prior.create_time() - previous["pid_creation_time"]) < .01:
            raise RuntimeError("Recorded learner is already active; refusing duplicate")
    except psutil.NoSuchProcess:
        pass
    latest = json.loads((RUN / "latest.json").read_text())
    if digest(RUN / latest["checkpoint"]) != latest["checkpoint_sha256"]:
        raise ValueError("Interrupted checkpoint hash changed")
    trainer = ROOT / "scripts/train_build_order_hud_v1.py"
    if digest(trainer) != "3960cb8f3ca13bc6b728920d5dea1f7c9d84781da98585ea2984dc8602180bbd":
        raise ValueError("Pinned trainer changed")
    arguments = [str(trainer), "--dataset", "runs/player-expansion-contract-review-v1/scoped619-v1/sequences-v2",
        "--hud-sidecar", "runs/own-hud-feature-extraction-v1/data-v1",
        "--hud-review", "runs/own-hud-feature-extraction-v1/independent-review-v1.json",
        "--parent-run", "runs/build-order-prior-v1/fit619-v1",
        "--baseline-audit", "runs/build-order-depth-v1/preferred619-depth-audit.json",
        "--output", "runs/build-order-hud-v1/fit-v1", "--threads", "2", "--resume", "--continuous",
        "--continuation-review", "runs/build-order-hud-v1/continuation-review-v1.json"]
    process = psutil.Process()
    receipt = {"at": datetime.now(timezone.utc).isoformat(), "pid": process.pid,
        "creation_time": process.create_time(), "parent_pid": process.ppid(),
        "argv": arguments, "resumed_from": latest, "host_source_sha256": digest(__file__),
        "stdout": str(Path(sys.stdout.name)), "stderr": str(Path(sys.stderr.name)),
        "launch_method": "Win32_Process.Create with CREATE_NO_WINDOW; no SC2 launch"}
    (HERE / f"{stamp}.launch.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"host_started": True, "pid": process.pid, "adapter_resume": latest["adapter_updates"]}), flush=True)
    sys.argv = arguments
    runpy.run_path(str(trainer), run_name="__main__")


if __name__ == "__main__":
    main()
