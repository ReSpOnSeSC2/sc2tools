"""The few obs-websocket reads the Stream Guardian needs, on its own connection.

One reading is two requests while OBS is not live and at most four while it
is. Nothing here writes to OBS, and nothing raises: an OBS that cannot be
reached is a reading of None, which no rule treats as a problem.
"""
from __future__ import annotations

import logging

from ..obs_activity import outputs_active
from .obs_reader import ObsConnection

LOG = logging.getLogger(__name__)
#: Input kinds that carry sound. A microphone is an "input capture" on every platform.
AUDIO_KINDS = ("input_capture", "audio")


def _count(value):
    return value if type(value) is int and value >= 0 else None


def _scene_name(response):
    for field in ("current_program_scene_name", "scene_name"):
        value = getattr(response, field, None)
        if isinstance(value, str) and value:
            return value
    return None


class ObsGuardianProbe(ObsConnection):
    def __call__(self, microphone="", *, plugin_outputs=False):
        """A reading of OBS, or None when it cannot be reached or read.

        `plugin_outputs` also asks the plugin outputs (Aitum and similar) when the
        native stream and recording are both off, so a stream that only runs
        through a plugin is not mistaken for no capture at all.
        """
        if self.disabled:
            return None
        with self.lock:
            try:
                raw = self._connection()
                stream = raw.get_stream_status()
                reading = {"streaming": stream.output_active is True,
                           "reconnecting": getattr(stream, "output_reconnecting", False) is True,
                           "skipped": _count(getattr(stream, "output_skipped_frames", None)),
                           "total": _count(getattr(stream, "output_total_frames", None)),
                           "recording": raw.get_record_status().output_active is True,
                           "scene": None, "muted": None}
                reading["capturing"] = reading["streaming"] or reading["recording"]
                if reading["streaming"]:
                    reading["scene"] = _scene_name(raw.get_current_program_scene())
                    if microphone:
                        reading["muted"] = self._muted(raw, microphone)
                elif plugin_outputs and not reading["capturing"]:
                    reading["capturing"] = outputs_active(self)
                return reading
            except Exception as error:
                LOG.debug("OBS guardian read skipped: %s", type(error).__name__)
                self.close()
                return None

    @staticmethod
    def _muted(raw, microphone):
        """True or False for a known input; None when OBS has no input by that name."""
        try:
            muted = raw.get_input_mute(microphone).input_muted
        except Exception:
            return None
        return muted if isinstance(muted, bool) else None

    def inputs(self):
        """Names of the OBS inputs that carry sound, for the microphone picker. Raises ValueError with a reason."""
        if self.disabled:
            raise ValueError("OBS controls are disabled for this agent.")
        with self.lock:
            try:
                rows = self._connection().get_input_list().inputs
            except Exception:
                self.close()
                raise ValueError("OBS could not be reached. Open OBS, turn on its WebSocket server and try again.") from None
        names = [row["inputName"] for row in rows if isinstance(row, dict) and isinstance(row.get("inputName"), str)
                 and any(word in str(row.get("inputKind", "")) for word in AUDIO_KINDS)]
        return sorted(set(names), key=str.casefold)
