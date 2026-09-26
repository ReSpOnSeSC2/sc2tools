"""Read-only download of the owner's private or explicitly shared SC2Tools library.

The Bearer credential is read from one named environment variable and sent only
to the explicitly configured HTTPS API origin. Signed object-storage URLs are
used without credentials and never persisted. Redirects are refused on both
transports so credentials cannot migrate to another origin. An explicit public
sharing handle uses the owner's existing sharing setting and reads no token.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import time
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
from uuid import uuid4

from filelock import FileLock

MAX_REPLAY_BYTES = 5 * 1024 * 1024
MAX_JSON_BYTES = 2 * 1024 * 1024
MAX_PAGES = 100
MPQ_MAGIC = (b"MPQ\x1a", b"MPQ\x1b")


class RemoteSyncError(RuntimeError):
    """A sanitized error safe to show without revealing credentials or signed URLs."""

    def __init__(self, message: str, *, status: int | None = None):
        super().__init__(message)
        self.status = status


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RemoteSyncError("Redirect refused; configure the final HTTPS API or storage endpoint.")


def _https_url(url: str, *, api: bool = False) -> str:
    if not isinstance(url, str) or any(ord(c) < 33 for c in url):
        raise RemoteSyncError("Endpoint must be a valid HTTPS URL.")
    try:
        parsed = urlsplit(url)
        _ = parsed.port
    except ValueError:
        raise RemoteSyncError("Endpoint has an invalid port.") from None
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
        raise RemoteSyncError("Endpoints require HTTPS and cannot contain embedded credentials or fragments.")
    if api:
        if parsed.query or parsed.path.rstrip("/") not in ("", "/v1"):
            raise RemoteSyncError("API URL must be an HTTPS origin, optionally ending in /v1.")
        return urlunsplit(("https", parsed.netloc, "/v1", "", ""))
    return url


def _read_url(url: str, *, token: str | None, maximum: int, timeout: float, retries: int, purpose: str) -> bytes:
    # A new opener per request avoids shared cookie state between API and storage.
    headers = {"Accept": "application/json" if token is not None else "application/octet-stream",
               "Accept-Encoding": "identity", "User-Agent": "pluto-sc2-replay-sync/1"}
    if token is not None:
        headers["Authorization"] = "Bearer " + token
    for attempt in range(retries + 1):
        try:
            request = Request(url, headers=headers, method="GET")
            with build_opener(_NoRedirect()).open(request, timeout=timeout) as response:
                declared = response.headers.get("Content-Length")
                if declared is not None:
                    try:
                        length = int(declared)
                    except ValueError:
                        raise RemoteSyncError(f"{purpose} returned an invalid content length.") from None
                    if not 0 <= length <= maximum:
                        raise RemoteSyncError(f"{purpose} exceeds the permitted size.")
                chunks = []
                total = 0
                while True:
                    chunk = response.read(min(65536, maximum + 1 - total))
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > maximum:
                        raise RemoteSyncError(f"{purpose} exceeds the permitted size.")
                    chunks.append(chunk)
                if declared is not None and total != length:
                    raise RemoteSyncError(f"{purpose} ended before its declared size.")
                return b"".join(chunks)
        except HTTPError as error:
            status = error.code
            error.close()
            if status in (401, 403) and token is not None:
                raise RemoteSyncError("SC2Tools authentication failed; supply a valid session or device token.", status=status) from None
            if status not in (429, 500, 502, 503, 504) or attempt == retries:
                raise RemoteSyncError(f"{purpose} failed (HTTP {status}).", status=status) from None
        except (URLError, TimeoutError, ConnectionError, OSError):
            if attempt == retries:
                raise RemoteSyncError(f"{purpose} could not complete after bounded retries.") from None
        if attempt < retries:
            time.sleep(min(2 ** attempt, 4))
    raise AssertionError("Retry loop completed without a result")


def _api_json(url: str, token: str | None, timeout: float, retries: int) -> dict:
    raw = _read_url(url, token=token, maximum=MAX_JSON_BYTES, timeout=timeout, retries=retries, purpose="SC2Tools API request")
    try:
        payload = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        raise RemoteSyncError("SC2Tools API returned invalid JSON.") from None
    if not isinstance(payload, dict):
        raise RemoteSyncError("SC2Tools API returned an unexpected response shape.")
    return payload


def _validate_replay(data: bytes, *, expected_size: int | None = None, expected_hash: str | None = None) -> str:
    if not 4 <= len(data) <= MAX_REPLAY_BYTES or data[:4] not in MPQ_MAGIC:
        raise RemoteSyncError("Downloaded file is not a size-bounded MPQ replay archive.")
    if expected_size is not None and len(data) != expected_size:
        raise RemoteSyncError("Replay size does not match the owner's library record.")
    digest = hashlib.sha256(data).hexdigest()
    if expected_hash is not None:
        if not re.fullmatch(r"[0-9a-fA-F]{64}", expected_hash) or digest != expected_hash.lower():
            raise RemoteSyncError("Replay SHA256 does not match the API record.")
    return digest


def _atomic_write(path: Path, data: bytes) -> None:
    fd, name = tempfile.mkstemp(prefix=".replay-sync-", suffix=".part", dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        if path.exists() or path.is_symlink():
            raise RemoteSyncError("Refusing to overwrite an existing replay or manifest.")
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def sync_remote(
    api_url: str, output_dir: str | Path, *, token_env: str = "SC2TOOLS_TOKEN",
    limit: int = 100, race: str = "P", timeout: float = 30.0, retries: int = 2,
    public_handle: str | None = None,
) -> dict:
    """Download up to ``limit`` own Protoss originals and write a secret-free manifest.

    Does not import/train: the replay importer must still check the eight-worker
    start, game version, camera data and player identity. The current SC2Tools API
    exposes size but no checksum; computed SHA256 is integrity provenance, not an
    independently trusted remote checksum unless an optional hash is returned.
    ``public_handle`` selects an already owner-enabled shared archive; this code
    never changes sharing settings or falls back to a different identity.
    """
    base = _https_url(api_url, api=True)
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 10000:
        raise ValueError("limit must be an integer from 1 through 10000")
    if race.upper() not in ("P", "PROTOSS"):
        raise ValueError("This workflow downloads the requested Protoss games only")
    if not 0 < timeout <= 120 or isinstance(retries, bool) or not isinstance(retries, int) or not 0 <= retries <= 5:
        raise ValueError("timeout must be positive and at most 120 seconds; retries must be 0..5")
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", token_env):
        raise ValueError("token_env must name an environment variable")
    token: str | None = None
    if public_handle is not None:
        if not isinstance(public_handle, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", public_handle):
            raise ValueError("public_handle must be the explicit owner-enabled sharing handle")
        list_endpoint = base + "/public/replays/" + quote(public_handle, safe="")
    else:
        token = os.environ.get(token_env, "").strip()
        if not token:
            raise RemoteSyncError(f"Set {token_env} to your SC2Tools session or device token before syncing.")
        if len(token) > 4096 or any(c.isspace() or ord(c) < 33 for c in token):
            raise RemoteSyncError("The supplied authentication token has an invalid format.")
        list_endpoint = base + "/replays"
    destination = Path(output_dir).expanduser().resolve()
    destination.mkdir(parents=True, exist_ok=True)
    entries: list[dict] = []
    failures: list[dict] = []
    scanned = skipped = 0
    cursor = None
    seen_cursors: set[str] = set()
    seen_games: set[str] = set()
    exhausted = False
    fatal_error: RemoteSyncError | None = None
    last_public_download = -float("inf")
    with FileLock(str(destination / ".replay-sync.lock"), timeout=1):
        try:
            for _page_number in range(MAX_PAGES):
                query = {"limit": min(100, max(1, limit - len(entries))), "race": "P", "sort": "date_desc"}
                if cursor is not None:
                    query["cursor"] = cursor
                page = _api_json(list_endpoint + "?" + urlencode(query), token, timeout, retries)
                items = page.get("items")
                envelope = page.get("page")
                if not isinstance(items, list) or len(items) > 100 or not isinstance(envelope, dict):
                    raise RemoteSyncError("Replay library returned an invalid page.")
                for item in items:
                    scanned += 1
                    if not isinstance(item, dict):
                        raise RemoteSyncError("Replay library returned an invalid entry.")
                    game_id = item.get("gameId")
                    if not isinstance(game_id, str) or not 1 <= len(game_id) <= 200 or any(ord(c) < 32 for c in game_id):
                        raise RemoteSyncError("Replay library returned an invalid game identifier.")
                    if game_id in seen_games:
                        continue
                    seen_games.add(game_id)
                    if str(item.get("myRace", "")).upper() not in ("P", "PROTOSS") or item.get("replayAvailable") is not True:
                        skipped += 1
                        continue
                    expected_size = item.get("replaySizeBytes")
                    if isinstance(expected_size, bool) or not isinstance(expected_size, int) or not 4 <= expected_size <= MAX_REPLAY_BYTES:
                        failures.append({"game_id": game_id, "reason": "Invalid replay size in library record."})
                        continue
                    # Server filenames and game IDs never become filesystem paths.
                    path = destination / ("sc2tools-" + hashlib.sha256(game_id.encode()).hexdigest()[:24] + ".SC2Replay")
                    try:
                        if public_handle is not None:
                            # The owner-enabled download route allows 20 requests/min.
                            delay = 3.1 - (time.monotonic() - last_public_download)
                            if delay > 0:
                                time.sleep(delay)
                            last_public_download = time.monotonic()
                            download_endpoint = list_endpoint + "/" + quote(game_id, safe="") + "/download"
                        else:
                            download_endpoint = base + "/games/" + quote(game_id, safe="") + "/replay-download"
                        signed = _api_json(download_endpoint, token, timeout, retries)
                        url = _https_url(signed.get("url"))
                        expected_hash = signed.get("sha256", item.get("sha256"))
                        if expected_hash is not None and not isinstance(expected_hash, str):
                            raise RemoteSyncError("Replay download record contains an invalid checksum.")
                        existed = path.exists()
                        if path.is_symlink():
                            raise RemoteSyncError("Replay destination is a symbolic link.")
                        if existed:
                            if not path.is_file() or path.stat().st_size > MAX_REPLAY_BYTES:
                                raise RemoteSyncError("Existing replay cannot be safely validated.")
                            data = path.read_bytes()
                        else:
                            data = _read_url(url, token=None, maximum=MAX_REPLAY_BYTES, timeout=timeout, retries=retries, purpose="Replay download")
                        digest = _validate_replay(data, expected_size=expected_size, expected_hash=expected_hash)
                        if not existed:
                            _atomic_write(path, data)
                        entries.append({"game_id": game_id, "file": path.name, "size_bytes": len(data), "sha256": digest,
                                        "remote_checksum_verified": expected_hash is not None, "status": "existing" if existed else "downloaded", "race": "P"})
                    except RemoteSyncError as error:
                        if error.status in (401, 403) and str(error).startswith("SC2Tools authentication"):
                            raise
                        failures.append({"game_id": game_id, "reason": str(error)})
                    if len(entries) >= limit:
                        break
                if len(entries) >= limit:
                    break
                next_cursor = envelope.get("nextCursor")
                has_more = envelope.get("hasMore") is True
                if not has_more and next_cursor is None:
                    exhausted = True
                    break
                if not isinstance(next_cursor, str) or not 1 <= len(next_cursor) <= 512 or next_cursor in seen_cursors:
                    raise RemoteSyncError("Replay library pagination did not advance safely.")
                seen_cursors.add(next_cursor)
                cursor = next_cursor
        except RemoteSyncError as error:
            fatal_error = error
        timestamp = datetime.now(timezone.utc).isoformat()
        manifest = {"version": 1, "created_at": timestamp, "api_origin": urlunsplit((*urlsplit(base)[:2], "", "", "")),
                    "requested_race": "P", "requested_limit": limit, "public_handle": public_handle, "scanned": scanned, "skipped": skipped,
                    "exhausted": exhausted, "replays": entries, "failures": failures,
                    "error": str(fatal_error) if fatal_error else None}
        manifest_path = destination / f"sync-{uuid4().hex}.json"
        _atomic_write(manifest_path, json.dumps(manifest, indent=2, allow_nan=False).encode("utf-8"))
    if fatal_error:
        raise RemoteSyncError(f"{fatal_error} Partial results are recorded in {manifest_path}.", status=fatal_error.status) from None
    return {"downloaded": sum(e["status"] == "downloaded" for e in entries), "existing": sum(e["status"] == "existing" for e in entries),
            "failed": len(failures), "scanned": scanned, "skipped": skipped, "exhausted": exhausted,
            "manifest": str(manifest_path), "output_dir": str(destination), "files": [str(destination / e["file"]) for e in entries]}
