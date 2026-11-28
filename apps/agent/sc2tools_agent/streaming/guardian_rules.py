"""The four Stream Guardian rules as small state machines over OBS readings.

Each rule answers one question per reading: when did this incident start, or
None while there is no incident. Everything is a pure function of the readings,
the game clock and `now`, so a rule cannot warn about something that has
already cleared, and one incident is one start time however long it lasts.
"""
from __future__ import annotations

import re

MIC_MUTED_SECONDS = 120
BREAK_SECONDS = 20 * 60
GAME_GRACE_SECONDS = 10
#: Share of frames OBS skipped, measured over the frames since the last judged reading.
SKIPPED_RATIO = 0.05
#: Fewer new frames than this say nothing about quality (about two seconds at 30 fps).
MIN_FRAMES = 60
CONFIRM_READINGS = 2
BREAK_SCENE = re.compile(r"\b(brb|be right back|break|starting soon|intermission|afk|away)\b", re.IGNORECASE)


class MicMuted:
    """The chosen microphone has stayed muted for two minutes while the stream is live."""

    def __init__(self):
        self.muted_at = None

    def update(self, reading, game, now):
        if not (reading and reading["streaming"] and reading["muted"] is True):
            self.muted_at = None
            return None
        self.muted_at = self.muted_at or now
        return self.muted_at if now - self.muted_at >= MIC_MUTED_SECONDS else None


class StreamUnstable:
    """OBS is reconnecting, or skipping a share of frames in two readings in a row."""

    def __init__(self):
        self.reset()

    def reset(self):
        self.counts = None
        self.bad = self.good = 0
        self.first_bad = None
        self.since = None

    def update(self, reading, game, now):
        if not (reading and reading["streaming"]):
            self.reset()
            return None
        verdict = True if reading["reconnecting"] else self._frames_verdict(reading)
        if verdict is True:
            self.bad, self.good = self.bad + 1, 0
            self.first_bad = self.first_bad or now
        elif verdict is False:
            self.bad, self.good = 0, self.good + 1
            self.first_bad = None
        if self.since is None and (self.bad >= CONFIRM_READINGS or reading["reconnecting"]):
            self.since = self.first_bad
        elif self.since is not None and self.good >= CONFIRM_READINGS:
            self.since = None
        return self.since

    def _frames_verdict(self, reading):
        """True when too many frames were skipped, False when not, None while there are too few to judge."""
        skipped, total = reading["skipped"], reading["total"]
        if skipped is None or total is None:
            return None
        if self.counts is None or skipped < self.counts[0] or total < self.counts[1]:
            self.counts = (skipped, total)  # a new stream: counting starts over
            return None
        new_total = total - self.counts[1]
        if new_total < MIN_FRAMES:
            return None
        verdict = (skipped - self.counts[0]) / new_total >= SKIPPED_RATIO
        self.counts = (skipped, total)
        return verdict


class NotCapturing:
    """A game has been running a few seconds and OBS is neither streaming nor recording."""

    def update(self, reading, game, now):
        if not reading or reading["capturing"] or game.active_since is None:
            return None
        return game.active_since if now - game.active_since >= GAME_GRACE_SECONDS else None


class StuckOnBreak:
    """Live on a break scene for twenty minutes after the last game ended or the scene was chosen."""

    def __init__(self):
        self.entered = None

    def update(self, reading, game, now):
        on_break = bool(reading and reading["streaming"] and BREAK_SCENE.search(reading["scene"] or ""))
        if not on_break:
            self.entered = None
            return None
        self.entered = self.entered or now
        reference = max(self.entered, game.last_end or 0)
        return reference if now - reference >= BREAK_SECONDS else None


class GuardianRules:
    def __init__(self):
        self.rules = {"mic_muted": MicMuted(), "stream_unstable": StreamUnstable(),
                      "not_recording": NotCapturing(), "stuck_on_break": StuckOnBreak()}

    def evaluate(self, switches, reading, game, now):
        """{rule: incident start} for the rules that are on and see an incident.

        A rule that is off is not asked, and forgets what it saw, so turning it on
        later starts from nothing instead of from a stale incident.
        """
        found = {}
        for name, rule in self.rules.items():
            if not switches.get(name):
                self.rules[name] = type(rule)()
                continue
            since = rule.update(reading, game, now)
            if since is not None:
                found[name] = since
        return found
