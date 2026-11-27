"""The optional OBS recording marker at each game start.

Runs beside the title and channel updates on the same game-start claim. It
makes no provider request and never raises into them.
"""
from __future__ import annotations

import copy

from .title_channel import RACE_LETTERS


def chapter_name(stats):
    """"Game 4 · PvZ": the game's place in the session and its matchup when both races are known."""
    stats = stats if isinstance(stats, dict) else {}
    session = stats.get("session") if isinstance(stats.get("session"), dict) else {}
    match = stats.get("currentMatch") if isinstance(stats.get("currentMatch"), dict) else {}
    played = [session.get(key) for key in ("wins", "losses")]
    number = sum(value for value in played if type(value) is int and value >= 0) + 1
    mine, theirs = RACE_LETTERS.get(match.get("race")), RACE_LETTERS.get(match.get("opponentRace"))
    return f"Game {number} · {mine}v{theirs}" if mine and theirs else f"Game {number}"


class RecordChapterMixin:
    def record_pending(self, game_key):
        settings = self.settings
        return settings["record_chapters"] and settings["last_record_game"] != game_key

    def mark_recording(self, game_key):
        """One attempt per game. The receipt is saved first, so a restart never marks twice."""
        settings = copy.deepcopy(self.settings)
        settings["last_record_game"] = game_key
        self._persist(settings)
        self.settings = settings
        self.service.chapter_marker(chapter_name(self._title_stats()))
