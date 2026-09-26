"""Integration probe for spatial selection and command execution, not training.

This deliberately accepts a normal melee map to isolate the input interface.
It never produces a checkpoint or passes its trajectories to the learner.
"""

import argparse
from pathlib import Path

from sc2.bot_ai import BotAI
from sc2.data import Difficulty, Race
from sc2.ids.ability_id import AbilityId
from sc2.ids.unit_typeid import UnitTypeId
from sc2.main import run_game
from sc2.player import Bot, Computer

from pluto_sc2.fairplay import FairPlayController
from pluto_sc2.runner import resolve_map, spatial_client, write_json
from pluto_sc2.sc2_adapter import execute_action, legal_action_mask
from pluto_sc2.schema import ACTION_TO_INDEX


class InterfaceProbe(BotAI):
    def __init__(self):
        super().__init__()
        self.fairplay = FairPlayController()
        self.selected_probe = False
        self.start_workers = 0
        self.trained = False
        self.pylon_issued = False
        self.frames = []

    async def on_start(self):
        self.start_workers = self.workers.amount
        if self.start_workers != 8:
            raise ValueError(f"Probe requires eight starting workers, observed {self.start_workers}")
        self.fairplay.reset(self.start_location)
        self.client.game_step = 8

    async def on_step(self, iteration):
        self.fairplay.sync_camera(self)
        self.frames.append({"loop": self.state.game_loop, "workers": self.workers.amount,
                            "minerals": self.minerals, "camera": list(self.fairplay.camera_center),
                            "selected": [u.unit_type for u in self.state.observation_raw.units if u.is_selected],
                            "on_screen": sum(u.is_on_screen for u in self.state.observation_raw.units)})
        if await self.fairplay.advance(self):
            return
        if not self.fairplay.can_issue(self.time):
            return
        if not self.selected_probe:
            worker = next((u for u in self.workers if self.fairplay.on_screen(u)), None)
            minerals = next((u for u in self.mineral_field if self.fairplay.on_screen(u)), None)
            if worker and minerals:
                self.selected_probe = await self.fairplay.issue(self, [worker], AbilityId.HARVEST_GATHER, minerals)
        elif not self.trained:
            nexus = next((u for u in self.townhalls if self.fairplay.on_screen(u)), None)
            if nexus and self.minerals >= 50:
                self.trained = await self.fairplay.issue(self, [nexus], AbilityId.NEXUSTRAIN_PROBE)
        elif not self.pylon_issued:
            mask = await legal_action_mask(self)
            action = ACTION_TO_INDEX["build_pylon"]
            if mask[action]:
                self.pylon_issued = await execute_action(self, action)


if __name__ == "__main__":
    import sys
    from loguru import logger

    logger.remove()
    logger.add(sys.stderr, level="INFO")
    parser = argparse.ArgumentParser()
    parser.add_argument("--map", required=True)
    parser.add_argument("--output", default="runs/interface-probe")
    args = parser.parse_args()
    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)
    bot = InterfaceProbe()
    with spatial_client():
        run_game(resolve_map(args.map), [Bot(Race.Protoss, bot), Computer(Race.Protoss, Difficulty.VeryEasy)],
                 realtime=False, game_time_limit=75, save_replay_as=str((out / "probe.SC2Replay").resolve()))
    write_json(out / "evidence.json", {"start_workers": bot.start_workers, "final_workers": bot.workers.amount,
                                      "ready_pylons": bot.structures(UnitTypeId.PYLON).ready.amount,
                                      "frames": bot.frames, "fairplay": bot.fairplay.summary()})
    write_json(out / "audit.json", {"summary": bot.fairplay.summary(), "actions": bot.fairplay.audit})
    assert bot.workers.amount > bot.start_workers, "Spatial training command did not produce a worker"
    assert bot.structures(UnitTypeId.PYLON).ready, "Spatial building command did not complete a Pylon"
