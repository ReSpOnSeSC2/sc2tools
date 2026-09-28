"""Classify why sc2reader could not load a replay.

Pure helpers shared by sandbox entry points (the browser Instant Analysis
engine, ``sc2tools_agent.instant_analysis``) that need to tell a user WHY a
replay failed instead of a bare ``parse_failed``. Nothing here touches the
filesystem or imports sc2reader, so the classification also works when a
test suite swapped sc2reader's classes and stays safe to bundle into a
browser runtime.

Kinds returned (a subset of the Instant Analysis ``ErrorKind`` contract):

* ``corrupt_file`` -- the MPQ archive or its self-describing header cannot
  be read. Header decoding is patch independent, so a failure there means
  damaged or truncated bytes, never a too-new game patch.
* ``unsupported_version`` -- the archive opens but sc2reader has no reader
  or protocol for the replay's build (a newer SC2 patch).
* ``parse_failed`` -- anything else.

Example:
    >>> classify_load_failure(ValueError("Valid replay.details reader could not found for build 99999"))
    'unsupported_version'
"""

from __future__ import annotations

from typing import Tuple

KIND_CORRUPT_FILE = "corrupt_file"
KIND_UNSUPPORTED_VERSION = "unsupported_version"
KIND_PARSE_FAILED = "parse_failed"

#: sc2reader 1.8.0 ``resources.py`` raises
#: ``ValueError("Valid {data_file} reader could not found for build {build}")``
#: when no reader is registered for the replay's base build.
UNKNOWN_BUILD_SIGNATURE = "reader could not found for build"

#: Copied from ``apps/replay-engine/scripts/preview_replay_cli.py``
#: (``_PATCH_TOO_NEW_SIGNATURES``) so both the landing-page preview and the
#: in-browser engine agree on what "replay from a newer patch" looks like.
#: Keep the two tuples in sync when either changes.
PATCH_TOO_NEW_SIGNATURES: Tuple[str, ...] = (
    "ord() expected a character",
    "ReadError",
    "is not a valid",  # protocol enum bumps
    "BuildIdNotSupported",
    "could not load protocol",
    "no module named 'sc2reader.resources.protocol",
    "tuple index out of range",  # truncated protocol tables
)

_MPQ_ERROR_CLASS = "MPQError"
_SC2READER_MODULE_PREFIX = "sc2reader"


def is_mpq_error(exc: BaseException) -> bool:
    """Return True when ``exc`` is (a subclass of) sc2reader's ``MPQError``.

    Matches by class name and defining module across the MRO instead of
    ``isinstance`` so a second copy of sc2reader (test shims, re-imports)
    cannot hide an archive failure.

    Args:
        exc: The exception raised while loading the replay.

    Returns:
        True for sc2reader ``MPQError`` instances, False otherwise.

    Example:
        >>> is_mpq_error(RuntimeError("boom"))
        False
    """
    for cls in type(exc).__mro__:
        module = getattr(cls, "__module__", "") or ""
        if cls.__name__ == _MPQ_ERROR_CLASS and module.startswith(_SC2READER_MODULE_PREFIX):
            return True
    return False


def looks_like_newer_patch(exc: BaseException) -> bool:
    """Return True when ``exc`` matches a known "patch too new" signature.

    Args:
        exc: The exception raised while loading the replay.

    Returns:
        True if the class name or message contains an unknown-build or
        newer-protocol signature (case-insensitive).

    Example:
        >>> looks_like_newer_patch(KeyError("x"))
        False
    """
    text = f"{type(exc).__name__}: {exc}".lower()
    if UNKNOWN_BUILD_SIGNATURE in text:
        return True
    return any(signature.lower() in text for signature in PATCH_TOO_NEW_SIGNATURES)


def classify_load_failure(exc: BaseException, *, header_readable: bool = True) -> str:
    """Map an sc2reader load exception to an Instant Analysis error kind.

    Args:
        exc: The exception raised by ``sc2reader.load_replay`` (or the
            engine's ``_load_replay`` wrapper).
        header_readable: Whether the same bytes load at sc2reader
            ``load_level=0`` (MPQ archive plus the self-describing replay
            header). ``False`` means the bytes are damaged, so the result is
            ``corrupt_file`` even when the message resembles a protocol
            signature (for example a zero-filled header raises
            ``TypeError: ord() expected a character``).

    Returns:
        ``corrupt_file``, ``unsupported_version`` or ``parse_failed``.

    Example:
        >>> classify_load_failure(TypeError("ord() expected a character"), header_readable=False)
        'corrupt_file'
        >>> classify_load_failure(AttributeError("nope"))
        'parse_failed'
    """
    if is_mpq_error(exc) or not header_readable:
        return KIND_CORRUPT_FILE
    if looks_like_newer_patch(exc):
        return KIND_UNSUPPORTED_VERSION
    return KIND_PARSE_FAILED
