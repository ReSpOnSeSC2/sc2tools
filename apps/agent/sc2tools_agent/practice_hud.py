"""Practice HUD preferences and the browser Ghost voice timing rules."""

from __future__ import annotations

import re


DEFAULT_PRACTICE = {"voice": False, "lead": 5, "hideCapture": True, "opacity": 100, "scale": 100}
_BOUNDS = {"lead": (1, 15), "opacity": (45, 100), "scale": (75, 150)}


def normalize_practice_preferences(raw):
    raw = raw if isinstance(raw, dict) else {}
    result = DEFAULT_PRACTICE.copy()
    for key in ("voice", "hideCapture"):
        if type(raw.get(key)) is bool:
            result[key] = raw[key]
    for key, (minimum, maximum) in _BOUNDS.items():
        value = raw.get(key)
        if type(value) is int and minimum <= value <= maximum:
            result[key] = value
    return result


def next_speak_index(steps, clock, last_spoken, lead=5):
    """Equivalent to lib/ghostVoice.ts nextSpeakIndex at the default lead."""
    index = last_spoken + 1
    return index if index < len(steps) and steps[index]["t"] - lead <= clock else None


def catch_up_index(steps, clock, last_spoken, lead=5):
    """Skip an overdue backlog after late join or a live clock jump."""
    while next_speak_index(steps, clock, last_spoken, lead) is not None:
        last_spoken += 1
    return last_spoken


class PracticeVoice:
    def __init__(self):
        self._target = None
        self._last_spoken = -1

    def next_line(self, game_key, target, clock, lead=5):
        steps = target["steps"]
        identity = (game_key, target.get("sourceGameId"), tuple((step["name"], step["t"]) for step in steps))
        if identity != self._target:
            self._target = identity
            self._last_spoken = -1
        index = catch_up_index(steps, clock, self._last_spoken, lead)
        if index == self._last_spoken:
            return None
        self._last_spoken = index
        name = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", steps[index]["name"])
        return "Next: " + name


def read_display_mode(files):
    """Read only the display mode, preferring the most recently saved SC2 file."""
    candidates = []
    for path in files:
        try:
            candidates.append((path.stat().st_mtime, path))
        except OSError:
            continue
    for _, path in sorted(candidates, key=lambda candidate: candidate[0], reverse=True):
        try:
            with path.open("r", encoding="utf-8-sig", errors="replace") as config:
                text = config.read(128 * 1024)
        except OSError:
            continue
        match = re.search(r"^\s*displaymode\s*=\s*([012])\s*$", text, re.IGNORECASE | re.MULTILINE)
        if match:
            return int(match[1])
    return None
