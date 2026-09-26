"""Bounded independent SC2 worker processes with shared validated replay cache."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

from filelock import FileLock


def configure_logging():
    from loguru import logger
    logger.remove()
    logger.add(sys.stderr, level="INFO")


def terminate_owned_process(process):
    if process.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False,
                       creationflags=subprocess.CREATE_NO_WINDOW)
    else:
        os.killpg(process.pid, signal.SIGTERM)
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=10)


def validated_entries(entries):
    """Freeze every replay's bytes and reject any supplied hash mismatch."""
    validated = []
    seen = set()
    for entry in entries:
        path = Path(entry["path"]).resolve()
        if path in seen:
            raise ValueError(f"Duplicate replay path in manifest: {path}")
        seen.add(path)
        with path.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        for field in ("sha256", "replay_id"):
            expected = entry.get(field)
            if expected is not None and str(expected).lower() != digest:
                raise ValueError(f"Replay content changed from the manifest: {path}")
        validated.append({**entry, "path": str(path), "sha256": digest})
    if not validated:
        raise ValueError("The manifest must contain at least one replay.")
    return validated


def balanced_batches(entries, workers):
    """Schedule longer matches first while balancing estimated game duration."""
    if not entries or not 1 <= workers <= 4:
        raise ValueError("Batch scheduling requires replay entries and 1-4 workers.")
    def duration(entry):
        value = entry.get("duration_seconds")
        return float(value) if isinstance(value, (int, float)) and math.isfinite(value) and value > 0 else 1.0
    batches = [[] for _ in range(min(workers, len(entries)))]
    totals = [0.0] * len(batches)
    for _, entry in sorted(enumerate(entries), key=lambda pair: (-duration(pair[1]), pair[0])):
        index = min(range(len(batches)), key=lambda index: (totals[index], index))
        batches[index].append(entry)
        totals[index] += duration(entry)
    return batches


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True, help="JSON object containing replays: [{path: ...}]")
    parser.add_argument("--output", required=True)
    parser.add_argument("--player", default="ReSpOnSe")
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--threads", type=int, default=2)
    parser.add_argument("--timeout-minutes", type=float, default=30)
    parser.add_argument("--cache-dir")
    parser.add_argument("--worker", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if not 1 <= args.workers <= 4 or args.threads < 1 or not 0 < args.timeout_minutes <= 120:
        parser.error("Use 1-4 workers, positive threads, and a timeout of at most 120 minutes.")
    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    entries = validated_entries(manifest["replays"])
    paths = [entry["path"] for entry in entries]
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    cache = Path(args.cache_dir).resolve() if args.cache_dir else output.parent / "replay-cache"
    configure_logging()
    if args.worker:
        import torch
        from pluto_sc2.replays import extract_replays
        torch.set_num_threads(args.threads)
        result = extract_replays(paths, output, player_name=args.player, cache_dir=cache)
        output.with_suffix(".report.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
        print(json.dumps({"output": str(output), "replays": len(paths), "samples": result["samples"]}), flush=True)
        return

    with FileLock(str(output) + ".import.lock", timeout=0):
        run_batches(args, entries, output, cache)


def run_batches(args, entries, output, cache):
    paths = [entry["path"] for entry in entries]

    work = output.parent / (output.stem + "-batches")
    work.mkdir(parents=True, exist_ok=True)
    children = []
    streams = []
    deadline = time.monotonic() + args.timeout_minutes * 60
    try:
        for index, batch_entries in enumerate(balanced_batches(entries, args.workers)):
            batch_manifest = work / f"batch-{index}.json"
            batch_manifest.write_text(json.dumps({"replays": batch_entries}, indent=2), encoding="utf-8")
            batch_output = work / f"batch-{index}.npz"
            log_path = work / f"batch-{index}.log"
            stream = log_path.open("w", encoding="utf-8")
            streams.append(stream)
            command = [sys.executable, str(Path(__file__).resolve()), "--worker", "--manifest", str(batch_manifest),
                       "--output", str(batch_output), "--player", args.player, "--threads", str(args.threads),
                       "--cache-dir", str(cache)]
            options = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {"start_new_session": True}
            child = subprocess.Popen(command, stdout=stream, stderr=subprocess.STDOUT, **options)
            children.append((index, child, log_path))
            print(f"Started worker {index + 1}: {len(batch_entries)} replays; log {log_path}", flush=True)
        completed = set()
        while len(completed) < len(children):
            for index, child, log_path in children:
                code = child.poll()
                if code is not None and index not in completed:
                    if code:
                        raise RuntimeError(f"Worker {index + 1} failed with exit code {code}; inspect {log_path}. Completed replay caches remain available.")
                    completed.add(index)
                    print(f"Worker {index + 1} completed ({len(completed)}/{len(children)})", flush=True)
            if time.monotonic() >= deadline:
                raise TimeoutError("Replay batch timeout reached; completed replay caches remain available.")
            if len(completed) < len(children):
                time.sleep(1)
        from pluto_sc2.replays import extract_replays
        validated_entries(entries)  # Reject source drift before the final cache merge.
        result = extract_replays(paths, output, player_name=args.player, cache_dir=cache)
        output.with_suffix(".report.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
        print(json.dumps({"output": str(output), "replays": len(paths), "samples": result["samples"]}), flush=True)
    finally:
        for _, child, _ in children:
            terminate_owned_process(child)
        for stream in streams:
            stream.close()


if __name__ == "__main__":
    main()
