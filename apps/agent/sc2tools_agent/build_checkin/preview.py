"""Fixed local-only card samples; no controller, storage or network access."""
from __future__ import annotations

from .models import BuildOptionModel, LoadingCardModel, PostgameCardModel, canonical_race
from .scouting import ScoutingStripModel


def _sample(race=None):
    mine = canonical_race(race)
    matchup, names = {
        "Protoss": ("PvZ", ("Gate Expand", "2 Stargate Phoenix", "Chargelot All-in")),
        "Terran": ("TvP", ("Reaper Expand", "2 Rax Reaper", "1-1-1")),
    }.get(mine, ("ZvP", ("12 Pool", "Hatch First", "Roach-Ravager")))
    options = tuple(BuildOptionModel(key=f"preview-{index}", name=name, source="catalog",
                                    group="yours", record=record, games=w+l, wins=w, losses=l)
                    for index, (name, record, w, l) in enumerate(zip(names, ("3–2", "7–3", "2–1"), (3, 7, 2), (2, 3, 1))))
    return matchup, options


def sample_loading_model(race=None) -> LoadingCardModel:
    matchup, options = _sample(race)
    return LoadingCardModel(
        game_key="preview-loading", title=f"{matchup} · vs PreviewOpponent · Alcyone",
        matchup=matchup, opponent_name="PreviewOpponent", waiting_for_matchup=False,
        featured=options,
        scouting=ScoutingStripModel(
            "You 3–2 · last met yesterday (W on Alcyone)",
            f"Usually: Gate Expand (3 of last 5) · Best: {options[1].name} 3–1",
            "Sample note: scout the ramp before moving out.", "/app/opponents",
        ),
    )


def sample_postgame_model(race=None) -> PostgameCardModel:
    matchup, options = _sample(race)
    return PostgameCardModel(
        card_id="preview-postgame", game_key="preview-loading", game_id="preview-game",
        title=f"Victory · {matchup} · vs PreviewOpponent · Alcyone",
        result="Victory", result_tone="success", matchup=matchup,
        opponent_name="PreviewOpponent", featured=options, selection=options[1].key,
        reason="usual", reason_label="Your usual build", can_add_build=True,
        detected_label=f"Replay classified as: {options[1].name}",
    )
