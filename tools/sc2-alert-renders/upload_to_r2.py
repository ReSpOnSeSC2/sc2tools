#!/usr/bin/env python3
"""Upload the SC2 alert render tree to Cloudflare R2.

Runs on the machine that holds the renders. Reads R2 credentials from the
environment or a local .env file; credentials are never printed, logged, or
written into the manifest.

    pip install boto3

Two buckets, both PRIVATE. Nothing here is ever served from a public bucket or
a custom domain: the media is derived from rights-controlled game assets and is
restricted to admin accounts, which the API enforces by handing out short-lived
presigned URLs.

  1. Full archive -- every take, PNG frame sequence, model and texture:

        python tools/sc2-alert-renders/upload_to_r2.py \
            --bucket sc2tools-alert-renders --prefix alert-renders/v1

  2. Delivery set -- only the approved animations the overlay presigns. Keys
     mirror the catalog paths in apps/web/lib/multichat/alerts.ts exactly, so
     "/alerts/sc2-3d/zealot-dance-3d.webm" maps to the object
     "alerts/sc2-3d/zealot-dance-3d.webm":

        python tools/sc2-alert-renders/upload_to_r2.py \
            --bucket sc2tools-alert-media --prefix alerts/sc2-3d \
            --source tools/sc2-alert-renders/output/production-authentic-approved-packaged

Required settings (env vars, or keys in the --env-file):

    R2_ENDPOINT            https://<account-id>.r2.cloudflarestorage.com
    R2_ACCESS_KEY_ID       bucket-scoped token access key id
    R2_SECRET_ACCESS_KEY   bucket-scoped token secret
    R2_BUCKET              default bucket when --bucket is not passed
    R2_REGION              optional, defaults to "auto"

The uploader is resumable and idempotent. Every object is compared against the
remote copy by size and by a SHA-256 recorded in object metadata, so a second
run re-uploads nothing and an interrupted run picks up where it stopped.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import mimetypes
import os
import queue
import sys
import threading
from dataclasses import dataclass, field
from pathlib import Path

try:
    import boto3
    from botocore.config import Config
    from botocore.exceptions import ClientError
except ImportError:  # pragma: no cover
    sys.exit("boto3 is required:  pip install boto3 python-dotenv")


DEFAULT_PREFIX = "alert-renders/v1"

# Content types the stdlib does not know or gets wrong for this asset mix.
CONTENT_TYPES = {
    ".webm": "video/webm",
    ".webp": "image/webp",
    ".png": "image/png",
    ".json": "application/json",
    ".dds": "image/vnd-ms.dds",
    ".m3": "application/octet-stream",
    ".m3a": "application/octet-stream",
    ".md": "text/markdown; charset=utf-8",
    ".py": "text/x-python; charset=utf-8",
    ".ps1": "text/plain; charset=utf-8",
    ".cpp": "text/x-c++src; charset=utf-8",
}

# Never upload these, wherever they appear in the tree.
SKIP_DIRS = {"__pycache__", ".git", ".venv", "node_modules", "addons", "work"}
SKIP_SUFFIXES = {".pyc", ".pyo", ".blend1", ".tmp", ".lock"}

# Long-lived immutable media vs. everything else. Keys under a versioned prefix
# never change in place, so the media can be cached hard.
IMMUTABLE_SUFFIXES = {".webm", ".webp", ".png", ".dds", ".m3", ".m3a"}
CACHE_IMMUTABLE = "public, max-age=31536000, immutable"
CACHE_DEFAULT = "public, max-age=300"


@dataclass
class Stats:
    uploaded: int = 0
    skipped: int = 0
    failed: int = 0
    bytes_sent: int = 0
    lock: threading.Lock = field(default_factory=threading.Lock)

    def record(self, *, uploaded=0, skipped=0, failed=0, bytes_sent=0):
        with self.lock:
            self.uploaded += uploaded
            self.skipped += skipped
            self.failed += failed
            self.bytes_sent += bytes_sent


def load_env_file(path: Path) -> None:
    """Merge KEY=VALUE lines from a .env file into os.environ.

    Existing environment variables win, so an explicitly exported value always
    overrides the file. Values are not echoed.
    """
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        sys.exit(
            f"Missing {name}.\n"
            "Set it in your environment or pass --env-file pointing at a file "
            "that defines it. See apps/api/.env.example for the full list."
        )
    return value


def sha256_of(path: Path, chunk: int = 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(chunk), b""):
            digest.update(block)
    return digest.hexdigest()


def content_type_for(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix in CONTENT_TYPES:
        return CONTENT_TYPES[suffix]
    guessed, _ = mimetypes.guess_type(path.name)
    return guessed or "application/octet-stream"


def should_skip(path: Path, root: Path) -> bool:
    if path.suffix.lower() in SKIP_SUFFIXES:
        return True
    return any(part in SKIP_DIRS for part in path.relative_to(root).parts[:-1])


def discover(root: Path) -> list[Path]:
    return sorted(
        p for p in root.rglob("*") if p.is_file() and not should_skip(p, root)
    )


def build_client(endpoint: str, region: str, key_id: str, secret: str):
    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        region_name=region,
        aws_access_key_id=key_id,
        aws_secret_access_key=secret,
        config=Config(
            retries={"max_attempts": 5, "mode": "standard"},
            # R2 rejects the streaming-chunked checksums newer botocore sends
            # by default; force the classic single-shot signature instead.
            request_checksum_calculation="when_required",
            response_checksum_validation="when_required",
            max_pool_connections=32,
        ),
    )


def remote_matches(client, bucket: str, key: str, size: int, digest: str) -> bool:
    """True when the object already in R2 is byte-identical to the local file."""
    try:
        head = client.head_object(Bucket=bucket, Key=key)
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code", "")
        if code in ("404", "NoSuchKey", "NotFound"):
            return False
        raise
    if head.get("ContentLength") != size:
        return False
    return head.get("Metadata", {}).get("sha256") == digest


def upload_one(client, bucket: str, prefix: str, root: Path, path: Path,
               stats: Stats, log: queue.Queue, dry_run: bool) -> dict | None:
    rel = path.relative_to(root).as_posix()
    key = f"{prefix}/{rel}" if prefix else rel
    size = path.stat().st_size
    try:
        digest = sha256_of(path)
        if remote_matches(client, bucket, key, size, digest):
            stats.record(skipped=1)
            return {"key": key, "bytes": size, "sha256": digest, "status": "present"}

        if not dry_run:
            cache = (
                CACHE_IMMUTABLE
                if path.suffix.lower() in IMMUTABLE_SUFFIXES
                else CACHE_DEFAULT
            )
            client.upload_file(
                str(path),
                bucket,
                key,
                ExtraArgs={
                    "ContentType": content_type_for(path),
                    "CacheControl": cache,
                    "Metadata": {"sha256": digest},
                },
            )
        stats.record(uploaded=1, bytes_sent=size)
        log.put(f"  up  {rel}  ({size / 1e6:.2f} MB)")
        return {"key": key, "bytes": size, "sha256": digest, "status": "uploaded"}
    except Exception as exc:  # noqa: BLE001 - report and keep going
        stats.record(failed=1)
        log.put(f"  ERR {rel}: {exc}")
        return None


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Upload the SC2 alert render tree to Cloudflare R2."
    )
    parser.add_argument(
        "--source",
        default="tools/sc2-alert-renders",
        help="Render tree to upload (default: tools/sc2-alert-renders)",
    )
    parser.add_argument(
        "--prefix",
        default=os.environ.get("R2_RENDER_PREFIX", DEFAULT_PREFIX),
        help=f"Key prefix in the bucket (default: {DEFAULT_PREFIX})",
    )
    parser.add_argument(
        "--env-file",
        default="apps/api/.env",
        help="File to read R2 settings from (default: apps/api/.env)",
    )
    parser.add_argument(
        "--manifest",
        default="alert-renders-manifest.json",
        help="Where to write the upload manifest",
    )
    parser.add_argument(
        "--bucket",
        default=None,
        help="Target bucket. Overrides R2_BUCKET.",
    )
    parser.add_argument("--workers", type=int, default=8, help="Parallel uploads")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="List what would be uploaded without writing anything",
    )
    args = parser.parse_args()

    root = Path(args.source).resolve()
    if not root.is_dir():
        sys.exit(f"Source directory not found: {root}")

    load_env_file(Path(args.env_file))
    endpoint = require_env("R2_ENDPOINT")
    bucket = (args.bucket or "").strip() or require_env("R2_BUCKET")
    key_id = require_env("R2_ACCESS_KEY_ID")
    secret = require_env("R2_SECRET_ACCESS_KEY")
    region = os.environ.get("R2_REGION", "auto").strip() or "auto"
    prefix = args.prefix.strip("/")

    files = discover(root)
    total = sum(f.stat().st_size for f in files)
    print(f"source   {root}")
    print(f"bucket   {bucket}   prefix: {prefix or '(none)'}")
    print(f"files    {len(files):,}   total: {total / 1e9:.2f} GB")
    if args.dry_run:
        print("mode     DRY RUN - nothing will be written\n")
    else:
        print()

    client = build_client(endpoint, region, key_id, secret)
    stats = Stats()
    log: queue.Queue = queue.Queue()
    records: list[dict] = []

    def drain():
        while True:
            try:
                print(log.get_nowait())
            except queue.Empty:
                return

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = [
            pool.submit(
                upload_one, client, bucket, prefix, root, path, stats, log,
                args.dry_run,
            )
            for path in files
        ]
        for done, future in enumerate(
            concurrent.futures.as_completed(futures), start=1
        ):
            result = future.result()
            if result:
                records.append(result)
            if done % 100 == 0:
                drain()
                pct = done / len(files) * 100
                print(
                    f"[{done:,}/{len(files):,}  {pct:5.1f}%]  "
                    f"up {stats.uploaded:,}  skip {stats.skipped:,}  "
                    f"fail {stats.failed:,}  sent {stats.bytes_sent / 1e9:.2f} GB"
                )
    drain()

    records.sort(key=lambda r: r["key"])
    manifest = {
        "bucket": bucket,
        "prefix": prefix,
        "source": str(root),
        "fileCount": len(records),
        "totalBytes": sum(r["bytes"] for r in records),
        "objects": records,
    }
    Path(args.manifest).write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    print(
        f"\ndone   uploaded {stats.uploaded:,}   already present {stats.skipped:,}   "
        f"failed {stats.failed:,}   sent {stats.bytes_sent / 1e9:.2f} GB"
    )
    print(f"manifest written to {args.manifest}")
    if stats.failed:
        print("Some objects failed. Re-run to retry only those.")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
