"""Bounded ordinary-resource addon mechanics check; no learned policy or PPO.

Terran starts with eight workers, constructs one Factory Tech Lab through the
production adapter, and repeatedly lifts/lands on that same addon. The other
eight-worker participant issues no gameplay inputs. This checks a specific
repair path, not policy strength or a reproduction of the old native crash.
The stress loop explicitly bypasses the normal strategic lift-purpose mask;
actual ability availability, input pacing and landing geometry remain active.
"""
from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import psutil

from sc2.bot_ai import BotAI
from sc2.data import Race, Result
from sc2.ids.ability_id import AbilityId as A
from sc2.ids.unit_typeid import UnitTypeId as U
from sc2.main import run_game
from sc2.player import Bot
from sc2.position import Point2

from pluto_sc2.adversary import AdversaryBot, legal_action_mask, validate_adversary_audit
from pluto_sc2.adversary_addons import ADDONS
from pluto_sc2.league_client import league_clients
from pluto_sc2.runner import ManagedSC2Process, resolve_map, write_json


PURPOSE = "Scripted ordinary-resource Factory Tech Lab reuse verification; no learning or strength claim"
ADDON_TYPES = ADDONS["TECHLAB"] | ADDONS["REACTOR"]
SETUP_BUILDINGS = {
    "build_supplydepot": ("SUPPLYDEPOT", "SUPPLYDEPOTLOWERED"),
    "build_barracks": ("BARRACKS",), "build_refinery": ("REFINERY",),
    "build_factory": ("FACTORY",),
}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


@dataclass
class ConstructionLatch:
    """An accepted SCV command must become an observed completed structure.

    During this small serial diagnostic setup, issue no replacement worker
    orders while the previous command is travelling or constructing. API
    acceptance alone does not establish that construction started.
    """
    action: str
    site: Point2
    source_tags: tuple[int, ...]
    issued_at: float
    observed_tag: int | None = None

    def observe(self, now, structures):
        require(now >= self.issued_at, "Construction observation time moved backwards")
        matches = [u for u in structures if u.type_id.name in SETUP_BUILDINGS[self.action]
                   and u.position.distance_to(self.site) < .25
                   and (self.observed_tag is None or u.tag == self.observed_tag)]
        if not matches:
            require(self.observed_tag is None, "Observed diagnostic construction disappeared")
            require(now - self.issued_at <= 45, f"Accepted {self.action} never became observed construction")
            return False
        structure = matches[0]
        self.observed_tag = int(structure.tag)
        require(now - self.issued_at <= 150, f"Observed {self.action} did not complete within 150 seconds")
        return bool(structure.is_ready)

    def summary(self):
        return dict(action=self.action, site=list(self.site), source_tags=list(self.source_tags),
                    issued_at=self.issued_at, observed_tag=self.observed_tag)


def verify_evidence(report, audit):
    """Fail closed unless real observed attachments and accepted inputs agree."""
    require(report.get("starting_workers") == [8, 8], "Both starts must have exactly eight workers")
    require(report.get("engine_results") == ["Defeat", "Victory"], "Missing native paired diagnostic concession")
    require(report.get("concession_reason") == "verification_complete", "Verification did not finish before leaving")
    require(report.get("cycles_completed") == report["cycles_requested"], "Reuse cycle count incomplete")
    require(report.get("stable_seconds", 0) >= 15, "No stable post-reuse interval")
    require(report.get("max_owned_addons") == 1, "Addon accumulation or missing addon")
    events = report.get("events", [])
    attachments = [e for e in events if e["kind"] == "reattached"]
    require(len(attachments) == report["cycles_requested"], "Missing observed reattachment evidence")
    require(len({e["addon_tag"] for e in attachments}) == 1, "Reuse did not retain the same addon")
    initial = [e for e in events if e["kind"] == "initial_attachment"]
    detached = [e for e in events if e["kind"] == "detached"]
    require(len(initial) == 1 and len(detached) == report["cycles_requested"], "Missing initial/detached evidence")
    require(all(e["addon_tag"] == initial[0]["addon_tag"] for e in detached + attachments),
            "Observed cycles refer to an addon other than the initial one")
    commands = [e for e in audit["actions"] if e.get("result") == [1]]
    require(sum(e["ability"] == A.BUILD_TECHLAB_FACTORY.value for e in commands) == 1,
            "Expected exactly one accepted Factory Tech Lab construction")
    for ability in (A.LIFT_FACTORY, A.LAND_FACTORY):
        require(sum(e["ability"] == ability.value for e in commands) == report["cycles_requested"],
                f"Accepted {ability.name} count differs from observed cycles")
    validate_adversary_audit(audit)


class PassiveProtoss(BotAI):
    def __init__(self, report):
        super().__init__()
        self.report = report
        self.result = None

    async def on_start(self):
        require(self.race == Race.Protoss and len(self.workers) == 8, "Invalid passive Protoss start")
        self.report["starting_workers"][1] = len(self.workers)
        self.client.game_step = 2

    async def on_step(self, iteration):
        pass

    async def on_end(self, result):
        self.result = result


class AddonVerificationBot(AdversaryBot):
    def __init__(self, report, output, seconds):
        super().__init__(None, "Terran", record=False, max_game_seconds=seconds, max_apm=600)
        self.report, self.output = report, output
        self.phase = "setup"
        self.factory_tag = self.addon_tag = None
        self.last_event = self.last_report = -100.0
        self.pending_construction = None
        self.stable_start = None
        self._diagnostic_allow_unpurposeful_lift = True

    async def on_start(self):
        await super().on_start()
        self.report["starting_workers"][0] = len(self.workers)

    def event(self, kind, **values):
        self.report["events"].append(dict(kind=kind, time=float(self.time),
                                           game_loop=int(self.state.game_loop), **values))
        self.last_event = float(self.time)

    def save(self):
        now = float(self.time) if getattr(self, "state", None) is not None else 0.0
        self.report.update(phase=self.phase, game_seconds=now,
                           control_rules=self.control_summary,
                           pending_construction=(self.pending_construction.summary()
                                                 if self.pending_construction else None))
        write_json(self.output / "verification.json", self.report)
        write_json(self.output / "audit.json", {"summary": self.fairplay.summary(), "actions": self.fairplay.audit})
        self.last_report = now

    async def issue_named(self, name, mask):
        index = self.spec.action_names.index(name)
        if not mask[index]:
            return False
        intent = self._action_context[index]
        accepted = await self.fairplay.issue(self, intent)
        if accepted:
            self.event("accepted_action", name=name)
            if name in SETUP_BUILDINGS:
                site = intent.target.position if hasattr(intent.target, "position") else intent.target
                self.pending_construction = ConstructionLatch(name, Point2(tuple(site)),
                                                               tuple(u.tag for u in intent.sources), float(self.time))
        return accepted

    async def concede(self, reason):
        self.report["concession_reason"] = reason
        self.event("concession", reason=reason)
        self.save()
        await self.client.leave()

    async def setup(self, mask):
        # Reserve accepted construction across delayed command observations.
        # Serial completion is deliberate in this mechanics-only diagnostic.
        if self.pending_construction is not None:
            previous_tag = self.pending_construction.observed_tag
            completed = self.pending_construction.observe(float(self.time), self.structures)
            if previous_tag is None and self.pending_construction.observed_tag is not None:
                self.event("observed_construction_started", **self.pending_construction.summary())
            if not completed:
                return
            self.event("observed_construction_completed", **self.pending_construction.summary())
            self.pending_construction = None
        for name, kinds in (("supplydepot", {U.SUPPLYDEPOT, U.SUPPLYDEPOTLOWERED}),
                            ("barracks", {U.BARRACKS}), ("refinery", {U.REFINERY}),
                            ("factory", {U.FACTORY})):
            if any(u.type_id in kinds for u in self.structures):
                continue
            action = "build_" + name
            if await self.issue_named(action, mask):
                return
            break
        # Only idle workers return to minerals: never oscillate gas workers.
        gas = self.structures.of_type({U.REFINERY}).ready
        if self.vespene < 150 and gas and sum(u.assigned_harvesters for u in gas) < 3:
            if await self.issue_named("harvest_gas", mask):
                return
        index = self.spec.action_names.index("harvest_minerals")
        if mask[index] and all(u.is_idle for u in self._action_context[index].sources):
            if await self.issue_named("harvest_minerals", mask):
                return
        factories = self.structures.of_type({U.FACTORY}).ready
        if factories:
            self.factory_tag = factories[0].tag
            if await self.issue_named("build_techlab_factory", mask):
                self.phase = "initial_addon"

    async def on_step(self, iteration):
        try:
            if self._episode_finished:
                return
            if (self.output / "STOP").exists():
                await self.concede("stop_marker")
                return
            if self.time >= self.max_game_seconds - 2:
                await self.concede("verification_timeout")
                return
            if self.time - self.last_report >= 5:
                self.save()
            if not self.fairplay.available(float(self.time)):
                return
            mask = await legal_action_mask(self)
            addons = [u for u in self.structures if u.type_id.name in ADDON_TYPES]
            self.report["max_owned_addons"] = max(self.report["max_owned_addons"], len(addons))
            require(len(addons) <= 1, "Unexpected extra addon during reuse")
            if self.phase == "setup":
                await self.setup(mask)
                return
            factory = next((u for u in self.structures if u.tag == self.factory_tag), None)
            require(factory is not None, "Tracked Factory disappeared")
            addon = next((u for u in addons if u.tag == factory.add_on_tag), None)
            if self.phase == "initial_addon":
                if addon is None or not addon.is_ready or not factory.is_idle:
                    return
                self.addon_tag = addon.tag
                self.event("initial_attachment", factory_tag=factory.tag, addon_tag=addon.tag,
                           factory_position=list(factory.position), addon_position=list(addon.position))
                self.phase = "attached"
            elif self.phase == "attached":
                require(factory.add_on_tag == self.addon_tag and not factory.is_flying,
                        "Unexpected attachment change")
                if self.time - self.last_event < 2:
                    return
                if self.report["cycles_completed"] == self.report["cycles_requested"]:
                    self.phase, self.stable_start = "stable", float(self.time)
                elif await self.issue_named("lift_factory", mask):
                    self.phase = "lifting"
            elif self.phase == "lifting":
                if not factory.is_flying or not factory.is_idle:
                    return
                detached = next((u for u in addons if u.tag == self.addon_tag), None)
                require(detached is not None and detached.is_ready and detached.is_visible,
                        "Detached addon is not currently visible and ready")
                index = self.spec.action_names.index("land_factory")
                if not mask[index]:
                    return
                intent = self._action_context[index]
                require(intent.sources[0].tag == factory.tag, "LAND targets a different Factory")
                expected = detached.position.offset((-2.5, .5))
                require(intent.target.distance_to(expected) < .01, "Production adapter did not choose addon reuse")
                self.event("detached", factory_tag=factory.tag, addon_tag=detached.tag,
                           expected_landing=list(expected))
                if await self.issue_named("land_factory", mask):
                    self.phase = "landing"
            elif self.phase == "landing":
                if factory.is_flying or factory.add_on_tag != self.addon_tag or not factory.is_idle:
                    return
                self.report["cycles_completed"] += 1
                self.event("reattached", cycle=self.report["cycles_completed"],
                           factory_tag=factory.tag, addon_tag=self.addon_tag,
                           factory_position=list(factory.position))
                self.phase = "attached"
            elif self.phase == "stable":
                require(factory.add_on_tag == self.addon_tag and not factory.is_flying,
                        "Reused addon detached during stability hold")
                self.report["stable_seconds"] = float(self.time) - self.stable_start
                if self.report["stable_seconds"] >= 15:
                    await self.concede("verification_complete")
        except Exception as error:
            self.error = f"{type(error).__name__}: {error}"
            self.report["bot_error"] = self.error
            self.save()
            raise


def verify(output, map_name, cycles=42, seconds=900):
    require(type(cycles) is int and 1 <= cycles <= 100, "Cycles must be an integer in 1..100")
    require(60 <= seconds <= 1800, "Verification must be bounded to 60..1800 game seconds")
    require(not any(p.info["name"].lower() == "sc2_x64.exe"
                    for p in psutil.process_iter(["name"])), "An SC2 client is already active; coordinate first")
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=False)
    report = dict(purpose=PURPOSE, started_at=datetime.now(timezone.utc).isoformat(), passed=False,
                  cycles_requested=cycles, cycles_completed=0, starting_workers=[None, None],
                  max_owned_addons=0, events=[], max_game_seconds=seconds, map=map_name,
                  debug_used=False, learned_policy_used=False, ppo_updates=0, corpus_writes=False)
    report["strategic_lift_purpose_override"] = "Explicit stress-test-only bypass; normal policies cannot perform this loop"
    bot, passive = AddonVerificationBot(report, output, seconds), PassiveProtoss(report)
    write_json(output / "verification.json", report)
    try:
        with league_clients():
            result = run_game(resolve_map(map_name), [Bot(Race.Terran, bot, name="Addon mechanics verification"),
                            Bot(Race.Protoss, passive, name="Passive verification peer")],
                              realtime=False, random_seed=98242, disable_fog=False,
                              game_time_limit=seconds, save_replay_as=str(output / "game.SC2Replay"))
        report["engine_results"] = [r.name for r in result]
        require(bot.error is None and bot._episode_finished and passive.result == Result.Victory,
                "Verification participant did not end cleanly")
        audit = {"summary": bot.fairplay.summary(), "actions": bot.fairplay.audit}
        verify_evidence(report, audit)
        require((output / "game.SC2Replay").is_file(), "Missing verification replay")
        report["passed"] = True
    except BaseException as error:
        report["error"] = f"{type(error).__name__}: {error}"
        raise
    finally:
        report["engine_lifecycle"] = list(ManagedSC2Process._lifecycle_events)
        report["finished_at"] = datetime.now(timezone.utc).isoformat()
        bot.save()
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True)
    parser.add_argument("--map", required=True)
    parser.add_argument("--cycles", type=int, default=42)
    parser.add_argument("--seconds", type=float, default=900)
    args = parser.parse_args()
    verify(args.output, args.map, args.cycles, args.seconds)


if __name__ == "__main__":
    main()
