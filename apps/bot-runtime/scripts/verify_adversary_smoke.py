"""One bounded live teacher smoke, with static production-data evidence."""
import argparse
from pathlib import Path

import torch

from sc2.dicts.unit_train_build_abilities import TRAIN_INFO

from pluto_sc2.bootstrap import collect, play_teacher
from pluto_sc2.replays import inspect_replay
from pluto_sc2.runner import write_json


def main():
    torch.set_num_threads(2)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--race", choices=("Terran", "Zerg"), required=True)
    parser.add_argument("--builds", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--map", required=True)
    parser.add_argument("--times", default="runs/base97563-production-times.json")
    args = parser.parse_args()

    def run(build, map_name, **kwargs):
        bot, report = play_teacher(build, map_name, **kwargs)
        replay = inspect_replay(kwargs["replay_path"])
        units = {}
        for value in bot.game_data.units.values():
            proto = value._proto
            ability = value.creation_ability
            units[str(proto.unit_id)] = dict(name=proto.name, unit_id=proto.unit_id,
                build_time=proto.build_time, mineral_cost=proto.mineral_cost,
                vespene_cost=proto.vespene_cost, food_required=proto.food_required,
                creation_ability_id=ability.exact_id.value if ability else None,
                creation_ability_name=ability.exact_id.name if ability else None)
        upgrades = {}
        for value in bot.game_data.upgrades.values():
            proto = value._proto
            upgrades[str(proto.upgrade_id)] = dict(name=proto.name, upgrade_id=proto.upgrade_id,
                research_time=proto.research_time, mineral_cost=proto.mineral_cost,
                vespene_cost=proto.vespene_cost, ability_id=proto.ability_id)
        mappings = {producer.name: {
            product.name: {key: (value.name if hasattr(value, "name") else value)
                           for key, value in data.items()}
            for product, data in products.items()}
            for producer, products in TRAIN_INFO.items()}
        write_json(Path(args.times), dict(source="Live SC2 ResponseData static production rules",
            base_build=replay["base_build"], game_version=replay["game_version"],
            replay_sha256=replay["replay_id"], replay_path=str(Path(kwargs["replay_path"]).resolve()),
            time_units="Raw SC2 data values, retained without inferred conversion",
            units=units, upgrades=upgrades, producer_mappings=mappings))
        return bot, report

    result = collect(args.builds, args.race, args.output, args.map, games=1,
                     max_game_seconds=360, max_apm=600, user_loss_weight=2,
                     match_runner=run)
    print({key: result[key] for key in ("race", "examples", "dataset", "dataset_sha256")})


if __name__ == "__main__":
    main()
