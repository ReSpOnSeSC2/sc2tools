"""Functions from controller records to card view models.

Everything a card shows is decided here, so the copy, the markers and
the pre-selection order are testable without the actor or Qt. The only
state they touch is a card's frozen option rows (first paint fixes the
order).
"""

from __future__ import annotations

from typing import NamedTuple, Optional, Tuple

from .models import (
    ADD_NEW_BUILD_HINT,
    ADD_NEW_BUILD_UNAVAILABLE,
    DETECTED_LABEL,
    LOCKED_IN,
    NOT_NOW_CLEARS_TIP,
    NOT_NOW_TIP,
    NOTES_FIRST_HEADING,
    NOTES_FIRST_PROMPT,
    OPPONENT_ROW,
    OPPONENT_UNKNOWN,
    PICKED_ON_WEB,
    POSTGAME_HEADING,
    RANDOMIZER_ROLLED,
    RANDOMIZER_ROLLING,
    RANDOMIZER_WILL_ROLL,
    STATUS_OPTIONS_FAILED,
    BuildOptions,
    BuildRef,
    GameIntentState,
    LoadingCardModel,
    OpponentIntent,
    OpponentRowModel,
    PostgameCardModel,
    RandomizerStripModel,
    card_title,
    opponent_change,
    option_models,
    reason_label,
    result_tone,
)
from .records import NOTES_FIRST, LiveGame, LoadingCard, PostgameCard


class Preselection(NamedTuple):
    key: Optional[str]
    reason: Optional[str]
    passed_rules: Optional[int] = None
    rule_count: Optional[int] = None


NO_PRESELECTION = Preselection(None, None)


def versus(opp_name: Optional[str]) -> Optional[str]:
    return f"vs {opp_name}" if opp_name else None


def loading_model(
    game: LiveGame,
    card: LoadingCard,
    *,
    options: Optional[BuildOptions],
    options_loading: bool,
    options_failed: bool,
    declared_elsewhere: Optional[BuildRef],
    show_intro: bool,
) -> LoadingCardModel:
    """The loading card for ``game``. Merges ``options`` into the card's
    frozen rows (first paint fixes the order)."""
    matchup = game.matchup
    if options is not None and options.builds:
        card.rows.merge(options.builds)
    roll = game.live.randomizer if game.live is not None else None
    locked = game.declared or declared_elsewhere
    changing = card.changing and locked is not None
    randomizer_on = (
        (game.live is not None and game.live.randomizer_enabled)
        or (options is not None and options.randomizer_enabled)
    )
    strip: Optional[RandomizerStripModel] = None
    if matchup and (randomizer_on or roll is not None) and locked is None:
        if roll is not None:
            strip = RandomizerStripModel(
                label=RANDOMIZER_ROLLED.format(name=roll.name),
                rolled_key=roll.key,
                rolled_name=roll.name,
            )
        elif game.randomizer_request_inflight:
            strip = RandomizerStripModel(label=RANDOMIZER_ROLLING)
        else:
            strip = RandomizerStripModel(
                label=RANDOMIZER_WILL_ROLL, can_roll_now=True,
            )
    featured, more = option_models(
        card.rows.ordered(),
        card.rows.featured,
        rolled_key=roll.key if roll is not None else None,
        usual_key=options.usual_key if options is not None else None,
    )
    status = card.status
    if (
        not status
        and matchup
        and options_failed
        and not options_loading
        and not card.rows.painted
    ):
        status = STATUS_OPTIONS_FAILED
    if game.declared is not None:
        locked_label = LOCKED_IN.format(name=game.declared.name)
    elif declared_elsewhere is not None:
        locked_label = PICKED_ON_WEB.format(name=declared_elsewhere.name)
    else:
        locked_label = None
    return LoadingCardModel(
        game_key=game.game_key,
        title=card_title(matchup, versus(game.opp_name)),
        matchup=matchup,
        opponent_name=game.opp_name,
        waiting_for_matchup=matchup is None,
        options_loading=bool(matchup) and options_loading and not card.rows.painted,
        featured=featured,
        more=more,
        randomizer=strip,
        collapsed=locked is not None and not changing,
        locked_label=locked_label,
        locked_key=locked.key if locked is not None else None,
        declared_elsewhere=game.declared is None and declared_elsewhere is not None,
        can_change=locked is not None and not changing,
        changing=changing,
        not_now_tip=NOT_NOW_CLEARS_TIP if changing else NOT_NOW_TIP,
        show_intro=show_intro,
        status=status,
        saving=game.declared is not None and game.writing,
    )


def server_has_declaration(
    server: Optional[GameIntentState],
    declared: BuildRef,
) -> bool:
    """Does the game's server state already carry this pick?"""
    if server is None:
        return False
    if server.build is not None and server.build.key == declared.key:
        return True
    suggestion = server.suggestion
    return (
        suggestion is not None
        and suggestion.reason == "declared"
        and suggestion.build.key == declared.key
    )


def preselection(
    card: PostgameCard,
    *,
    roll: Optional[BuildRef],
    options: Optional[BuildOptions],
) -> Preselection:
    """What an untouched end card selects, strongest signal first.

    1. The pick this agent made at loading, when the server lacks it
       (the declare never reached the cloud): reason ``declared``.
    2. Once the replay is in: the server's suggestion (it already folds
       in the randomizer roll and whether the replay deviated from it).
    3. Before the replay: the randomizer roll, then the matchup's usual.
    """
    declared = card.local_declared
    server = card.server
    if declared is not None and not server_has_declaration(server, declared):
        return Preselection(declared.key, "declared")
    if server is not None:
        if card.variant == NOTES_FIRST and server.build is not None:
            return Preselection(server.build.key, None)
        suggestion = server.suggestion
        if suggestion is None:
            return NO_PRESELECTION
        return Preselection(
            suggestion.build.key,
            suggestion.reason,
            suggestion.passed_rules,
            suggestion.rule_count,
        )
    if roll is not None:
        return Preselection(roll.key, "randomizer")
    if options is not None and options.usual_key and options.find(options.usual_key):
        return Preselection(options.usual_key, "usual")
    return NO_PRESELECTION


def opponent_pick(card: PostgameCard) -> Optional[str]:
    """The opponent row's key as this card shows it."""
    opp = card.server.opponent if card.server is not None else None
    if card.opp_touched or opp is None:
        return card.opp_selection
    return opp.effective_key


def opponent_write(card: PostgameCard) -> Optional[Tuple[Optional[str]]]:
    """``(opponentBuildKey,)`` an answer from this card must send, or
    ``None`` when the opponent's build stays as the server counts it."""
    opp = card.server.opponent if card.server is not None else None
    if opp is None or not card.opp_touched:
        return None
    return opponent_change(
        card.opp_selection,
        server_key=opp.effective_key,
        corrected=opp.corrected,
        replay_key=opp.detected_key,
    )


def _opponent_name(card: PostgameCard, opp: OpponentIntent, key: Optional[str]) -> Optional[str]:
    if not card.opp_touched:
        if opp.corrected and opp.build is not None:
            return opp.label or opp.build.name
        return opp.label or opp.detected_name
    if key is None:
        return opp.replay_name
    row = card.opp_rows.find(key)
    if row is not None:
        return row.name
    if opp.build is not None and opp.build.key == key:
        return opp.build.name
    return opp.replay_name if key == opp.detected_key else None


def opponent_row_model(
    card: PostgameCard,
    *,
    options_loading: bool,
) -> Optional[OpponentRowModel]:
    """The "Opponent's build" row, once the replay's state is in. Merges
    the opponent options into the card's frozen opponent rows."""
    opp = card.server.opponent if card.server is not None else None
    if opp is None:
        return None
    if opp.options is not None and opp.options.builds:
        card.opp_rows.merge(opp.options.builds)
    selection = opponent_pick(card)
    suggestion = opp.suggestion
    featured, more = option_models(
        card.opp_rows.ordered(),
        card.opp_rows.featured,
        suggested_key=suggestion.build.key if suggestion is not None else None,
    )
    name = _opponent_name(card, opp, selection) or OPPONENT_UNKNOWN
    # The row shows something other than the replay's own label.
    differs_from_replay = selection != opp.detected_key
    return OpponentRowModel(
        label=OPPONENT_ROW.format(name=name),
        name=name,
        selection=selection,
        server_key=opp.effective_key,
        replay_key=opp.detected_key,
        replay_name=opp.replay_name,
        corrected=opp.corrected,
        changed=opponent_write(card) is not None,
        detected_label=(
            DETECTED_LABEL.format(name=opp.replay_name)
            if differs_from_replay and opp.replay_name and opp.replay_name != name
            else None
        ),
        show_use_replay=differs_from_replay,
        featured=featured,
        more=more,
        options_loading=options_loading and not card.opp_rows.painted,
        touched=card.opp_touched,
    )


def postgame_model(
    card: PostgameCard,
    *,
    roll: Optional[BuildRef],
    options: Optional[BuildOptions],
    options_loading: bool,
    show_intro: bool,
) -> PostgameCardModel:
    """The end card. Merges ``options`` into the card's frozen rows."""
    server = card.server
    if options is not None and options.builds:
        card.rows.merge(options.builds)
    matchup = card.matchup
    result = card.result or (server.result if server is not None else None)
    opponent = card.opp_name or (server.opp_name if server is not None else None)
    suggestion = server.suggestion if server is not None else None
    roll = (server.randomizer if server is not None else None) or roll
    featured, more = option_models(
        card.rows.ordered(),
        card.rows.featured,
        rolled_key=roll.key if roll is not None else None,
        usual_key=options.usual_key if options is not None else None,
        suggested_key=suggestion.build.key if suggestion is not None else None,
    )
    detected_name = server.detected_name if server is not None else None
    notes_first = card.variant == NOTES_FIRST
    planned_name = (
        server.build.name
        if notes_first and server is not None and server.build is not None
        else None
    )
    prompt = (
        NOTES_FIRST_PROMPT.format(
            planned=planned_name,
            detected=detected_name or "something else",
        )
        if planned_name
        else None
    )
    return PostgameCardModel(
        card_id=card.card_id,
        game_key=card.game_key,
        game_id=card.game_id,
        variant=card.variant,
        heading=NOTES_FIRST_HEADING if notes_first else POSTGAME_HEADING,
        title=card_title(result, matchup, versus(opponent)),
        result=result,
        result_tone=result_tone(result),
        matchup=matchup,
        opponent_name=opponent,
        options_loading=options_loading and not card.rows.painted,
        featured=featured,
        more=more,
        selection=card.selection,
        reason=card.reason,
        reason_label=reason_label(
            card.reason,
            passed_rules=card.passed_rules,
            rule_count=card.rule_count,
        ),
        detected_label=(
            DETECTED_LABEL.format(name=detected_name) if detected_name else None
        ),
        prompt=prompt,
        planned_name=planned_name,
        detected_name=detected_name,
        randomizer_name=roll.name if roll is not None else None,
        notes=card.notes,
        opponent_note=card.opponent_note,
        opponent_note_touched=card.opponent_note_touched,
        opponent_note_status=card.opponent_note_status,
        opponent_note_busy=card.opponent_note_busy,
        opponent_pulse_id=card.opponent_pulse_id,
        status=card.status,
        busy=card.busy,
        touched=card.touched,
        show_intro=show_intro,
        opponent=opponent_row_model(card, options_loading=options_loading),
        can_add_build=card.game_id is not None,
        add_build_hint=(
            ADD_NEW_BUILD_HINT if card.game_id is not None else ADD_NEW_BUILD_UNAVAILABLE
        ),
    )


__all__ = [
    "NO_PRESELECTION",
    "Preselection",
    "loading_model",
    "opponent_pick",
    "opponent_row_model",
    "opponent_write",
    "postgame_model",
    "preselection",
    "server_has_declaration",
    "versus",
]
