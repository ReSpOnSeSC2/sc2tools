"""Private scouting actor operations, kept out of the check-in business logic.

All entry points enqueue work on BuildCheckinController's existing actor. HTTP
and preference persistence use its existing background executor, never Qt.
"""

from __future__ import annotations

from dataclasses import replace
from typing import Any

from .scouting import parse_scouting_brief, plain_text, scouting_model
from .view import HIDE_DISMISSED, HIDE_DISABLED

SCOUTING_RETRY_SEC = 5.0


class ScoutingControllerMixin:
    def on_scouting_brief(self, payload: Any) -> None:
        self._post(self._receive_scouting, payload)

    def set_scouting_enabled(self, enabled: bool) -> None:
        self._post(self._set_scouting_enabled, bool(enabled))

    @property
    def scouting_enabled(self) -> bool:
        return self._show_scouting

    def _set_scouting_enabled(self, enabled: bool) -> None:
        self._show_scouting = enabled
        if self._on_scouting_changed is not None:
            self._background(self._on_scouting_changed, enabled)
        self._view_call("update_prefs", self._prefs)
        self._enforce_prefs()
        game = self._current_game()
        if game is not None:
            self._render_loading(game)

    def _receive_scouting(self, payload: Any) -> None:
        game = self._current_game()
        if game is None or not game.in_progress:
            return
        brief = parse_scouting_brief(payload, game.game_key)
        if brief is None or (game.opp_name and brief.opponent_name.casefold() != game.opp_name.casefold()):
            return
        game.scouting = brief
        if not self._prefs.loading_cards and self._loading_may_show(game) and (
            game.loading is None or (not game.loading.visible and game.loading.hidden_reason == HIDE_DISABLED)
        ):
            self._show_loading(game)
        else:
            self._render_loading(game)

    def _ensure_scouting(self, game: Any) -> None:
        read = getattr(self._api, "get_scouting_brief", None)
        if (not self._show_scouting or not self._prefs.enabled or self._supported is False
                or game.display_time >= 30 or game.has_random or game.human_1v1() is not True
                or game.scouting is not None or not callable(read) or game.scouting_fetching):
            return
        now = self._clock()
        if game.scouting_read_at is not None and now - game.scouting_read_at < SCOUTING_RETRY_SEC:
            return
        game.scouting_fetching = True
        game.scouting_read_at = now
        self._call(self._scouting_read, game.game_key, read, game.game_key)

    def _scouting_read(self, key: str, value: Any, error: Any) -> None:
        game = self._games.get(key)
        if game is not None:
            game.scouting_fetching = False
        if error is None and key == self._current_key:
            self._receive_scouting(value)

    def _with_scouting(self, model: Any, game: Any) -> Any:
        only = not self._prefs.loading_cards
        scouting = scouting_model(game.scouting, self._wall_clock()) if self._show_scouting and game.scouting is not None else None
        return replace(model, scouting=scouting, scouting_only=only,
                       heading="Private scouting" if only else model.heading,
                       collapsed=False if only else model.collapsed,
                       show_intro=False if only else model.show_intro)

    def dismiss_scouting(self, game_key: str) -> None:
        self._post(self._dismiss_scouting, game_key)

    def _dismiss_scouting(self, game_key: str) -> None:
        game = self._current_game()
        if game is not None and game.game_key == game_key and not self._prefs.loading_cards:
            self._hide_loading(game, HIDE_DISMISSED)

    def open_scouting_dossier(self, game_key: str) -> None:
        self._post(self._open_scouting_dossier, game_key)

    def _open_scouting_dossier(self, game_key: str) -> None:
        game = self._games.get(game_key)
        if game is not None and game.scouting is not None:
            self._background(self._open_url, self._dashboard_url.rstrip("/") + game.scouting.dossier_path)

    def update_opponent_note(self, card_id: str, note: str) -> None:
        self._post(self._update_opponent_note, card_id, note)

    def _update_opponent_note(self, card_id: str, note: Any) -> None:
        card = self._cards.get(card_id)
        if card is None or not card.opponent_pulse_id:
            return
        card.opponent_note = plain_text(note, 500, trim=False)
        card.opponent_note_touched = True
        card.opponent_note_status = ""
        self._handle_interacted(card_id)
        self._render_card(card)

    def save_opponent_note(self, card_id: str, note: str) -> None:
        self._post(self._save_opponent_note, card_id, note)

    def _save_opponent_note(self, card_id: str, note: Any) -> None:
        card = self._cards.get(card_id)
        write = getattr(self._api, "put_opponent_note", None)
        if card is None or not card.game_id or not card.opponent_pulse_id or card.opponent_note_busy or not callable(write):
            return
        self._update_opponent_note(card_id, note)
        card.opponent_note_busy = True
        card.opponent_note_status = "Saving note…"
        self._render_card(card)
        self._call(self._opponent_note_saved, (card_id, card.opponent_note), write, card.opponent_pulse_id, card.opponent_note)

    def _opponent_note_saved(self, tag: tuple[str, str], value: Any, error: Any) -> None:
        card_id, sent = tag
        card = self._cards.get(card_id)
        if card is None:
            return
        card.opponent_note_busy = False
        card.opponent_note_status = "Couldn't save note. Try again." if error is not None else (
            "Saved for next time." if card.opponent_note == sent else "Saved. You have newer changes."
        )
        self._render_card(card)
