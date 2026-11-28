"""Stream Guardian settings: four independent switches, all off, and the microphone input.

Nothing here talks to OBS or the server. The switches are private to this
PC, so they do not follow an account change the way title settings do.
"""
from __future__ import annotations

RULES = ("mic_muted", "stream_unstable", "not_recording", "stuck_on_break")
MAX_INPUT_NAME = 256


def valid_input_name(value):
    """An OBS input name as OBS stores it: printable, not padded, not empty."""
    return (isinstance(value, str) and 0 < len(value) <= MAX_INPUT_NAME and value == value.strip()
            and not any(ord(char) < 32 or ord(char) == 127 for char in value))


def load_guardian_settings(value):
    value = value if isinstance(value, dict) else {}
    switches = value.get("switches") if isinstance(value.get("switches"), dict) else {}
    microphone = value.get("microphone")
    return {"switches": {rule: switches.get(rule) is True for rule in RULES},
            "microphone": microphone if valid_input_name(microphone) else ""}


def configure_guardian_settings(payload):
    """Strict opt-in: every switch must be an actual boolean."""
    switches = payload.get("switches") if isinstance(payload, dict) else None
    if (not isinstance(switches, dict) or set(switches) != set(RULES)
            or any(type(switches[rule]) is not bool for rule in RULES)):
        raise ValueError("Choose on or off for each Stream Guardian warning.")
    microphone = payload.get("microphone", "")
    microphone = microphone.strip() if isinstance(microphone, str) else None
    if microphone is None or microphone and not valid_input_name(microphone):
        raise ValueError("That OBS input name is not valid.")
    if switches["mic_muted"] and not microphone:
        raise ValueError("Choose which OBS input is your microphone before turning on the muted-microphone warning.")
    return {"switches": dict(switches), "microphone": microphone}
