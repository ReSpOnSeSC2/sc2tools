"""The few obs-websocket reads the Stream Guardian needs, on its own connection.

One reading is one to five requests, and only for the rules that are switched on.
Nothing here writes to OBS, and nothing raises: an OBS that cannot be reached is
a reading of None, which no rule treats as a problem.
"""
from __future__ import annotations

import logging

from .obs_reader import DEFAULT_OUTPUTS, ObsConnection

LOG = logging.getLogger(__name__)
#: Input kinds that carry sound. A microphone is an "input capture" on every platform.
AUDIO_KINDS = ("input_capture", "audio")
#: obs-websocket request status for an input or output that does not exist.
RESOURCE_NOT_FOUND = 600


def _count(value):
    return value if type(value) is int and value >= 0 else None


def _scene_name(response):
    for field in ("current_program_scene_name", "scene_name"):
        value = getattr(response, field, None)
        if isinstance(value, str) and value:
            return value
    return None


class ObsGuardianProbe(ObsConnection):
    def __init__(self, settings_provider, *, disabled=False, factory=None, output_names=None):
        super().__init__(settings_provider, disabled=disabled, factory=factory)
        self.output_names = output_names or (lambda: tuple(DEFAULT_OUTPUTS.values()))

    def __call__(self, microphone="", *, scene=False, record=False, plugins=False):
        """A reading of OBS, or None when it cannot be reached or read.

        Only the reads the rules that are on need: `microphone` and `scene` apply
        while live, `record` asks the recording status, and `plugins` also looks at
        the named plugin outputs (Aitum and similar), so a stream that runs only
        through a plugin still counts as live and as captured.
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
                           "recording": record and raw.get_record_status().output_active is True,
                           "scene": None, "muted": None, "mic_missing": False}
                if plugins and not reading["streaming"]:
                    reading["streaming"] = self._plugin_live(raw)
                reading["capturing"] = reading["streaming"] or reading["recording"]
                if reading["streaming"]:
                    if scene:
                        reading["scene"] = _scene_name(raw.get_current_program_scene())
                    if microphone:
                        self._read_mute(raw, microphone, reading)
                return reading
            except Exception as error:
                LOG.debug("OBS guardian read skipped: %s", type(error).__name__)
                self.close()
                return None

    def _plugin_live(self, raw):
        """True when a named plugin output is running. The virtual camera and replay buffer are not a stream."""
        listed = {row.get("outputName") for row in raw.get_output_list().outputs if isinstance(row, dict)}
        return any(raw.get_output_status(name).output_active is True
                   for name in self.output_names() if name in listed)

    @staticmethod
    def _read_mute(raw, microphone, reading):
        """Fill `muted`; an input OBS does not have is `mic_missing`, any other failure is a failed read."""
        try:
            muted = raw.get_input_mute(microphone).input_muted
        except Exception as error:
            if getattr(error, "code", None) != RESOURCE_NOT_FOUND:
                raise
            reading["mic_missing"] = True
            return
        reading["muted"] = muted if isinstance(muted, bool) else None

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
