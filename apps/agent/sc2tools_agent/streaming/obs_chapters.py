"""Chapter markers in the local OBS recording, one per game start.

obs-websocket 5.5 added CreateRecordChapter for OBS 30.2 and newer, and OBS
only accepts it while a hybrid MP4 is being recorded. Every other state is a
quiet "no marker": the stream and the title updates never wait on this.
"""
from __future__ import annotations

import logging

from .obs_reader import ObsConnection

LOG = logging.getLogger(__name__)
MIN_OBS_VERSION = (30, 2)
MAX_CHAPTER_LENGTH = 100


def obs_version(text):
    """(major, minor) from an OBS version string such as "30.2.1", or None."""
    parts = text.split(".") if isinstance(text, str) else []
    if len(parts) < 2 or not all(part.isdigit() for part in parts[:2]):
        return None
    return int(parts[0]), int(parts[1])


class RecordChapterMarker(ObsConnection):
    def __call__(self, name):
        """True when OBS accepted the marker. Never raises."""
        if self.disabled:
            return False
        with self.lock:
            try:
                raw = self._connection()
                version = obs_version(getattr(raw.get_version(), "obs_version", None))
                if version is None or version < MIN_OBS_VERSION:
                    return False
                if getattr(raw.get_record_status(), "output_active", None) is not True:
                    return False
                raw.send("CreateRecordChapter", {"chapterName": name[:MAX_CHAPTER_LENGTH]})
                return True
            except Exception as error:
                # An older format, a recording that just stopped or a dropped
                # connection all land here; the next game starts clean.
                LOG.debug("OBS chapter marker skipped: %s", type(error).__name__)
                self.close()
                return False
