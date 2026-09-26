"""Opt-in reward recording for the newer neural bot; no optimizer or launcher.

The existing preview and immutable replay-fit sources remain unchanged. This
adapter attaches the established observation-only reward collector to an opt-in
bot subclass, including frames spent executing multi-input intents. Rewards are
feedback records, never extra actor inputs. Policy-gradient training still needs
a separately verified trajectory/log-probability/value and optimizer integration.
"""
from __future__ import annotations

from copy import deepcopy
import hashlib
import json
from pathlib import Path

from .alphastar_live import AlphaStarLiveBot, PredictionDriver
from .policy_intents import canonical_sha256
from .reward_observation import RewardCollector
from .rewards import RewardConfig
from .sc2_adapter import screen_entities

SCHEMA = "restricted-neural-reward-feedback-v1"


class NeuralRewardFeedback:
    def __init__(self, *, session_id, checkpoint_sha256, reward_config=None):
        if not isinstance(session_id, str) or not session_id:
            raise ValueError("Reward feedback requires a game session")
        if (not isinstance(checkpoint_sha256, str) or len(checkpoint_sha256) != 64
                or any(c not in "0123456789abcdef" for c in checkpoint_sha256)):
            raise ValueError("Reward feedback requires an exact checkpoint hash")
        self.session_id = session_id
        self.checkpoint_sha256 = checkpoint_sha256
        self.config = reward_config or RewardConfig()
        if not isinstance(self.config, RewardConfig):
            raise ValueError("Explicit validated RewardConfig required")
        self.collector = RewardCollector(self.config)
        self.receipts = []
        self.closed = False
        self.outcome = None
        self.rejection = None

    def observe(self, bot, frame):
        if self.closed:
            raise RuntimeError("Reward episode already closed")
        loop = int(bot.state.game_loop)
        if (frame.get("game_loop") != loop or frame.get("hud", {}).get("player_id") != 1
                or getattr(bot, "player_id", None) != 1):
            raise ValueError("Reward frame is not the current native player observation")
        if getattr(getattr(bot.fairplay, "budget", None), "max_apm", None) != 200:
            raise ValueError("Neural reward adapter requires the paid200APM controller")
        if self.collector.last_loop is not None and loop <= self.collector.last_loop:
            raise ValueError("Reward observations must be strictly increasing")
        # No global own/enemy lists or score-based kills are passed to the collector.
        own, enemies = screen_entities(bot)
        previous = self.collector.engine.summary()["components"]
        self.collector.observe(bot, own, enemies, camera_restricted=True)
        current = self.collector.engine.summary()["components"]
        receipt = {
            "game_loop": loop, "frame_sha256": canonical_sha256(frame),
            "reward": self.collector.take(),
            "components": {name: value - previous.get(name, 0.0)
                           for name, value in current.items() if value != previous.get(name, 0.0)},
            "scope": "Permitted observation change since previous frame; no command-attempt reward",
        }
        self.receipts.append(receipt)
        return deepcopy(receipt)

    def finish(self, outcome, *, time_limited=False, failure=None, replay_verified=False):
        if self.closed:
            raise RuntimeError("Terminal feedback already recorded")
        self.closed = True
        if failure or outcome not in {"victory", "defeat", "tie"}:
            # A model/transport failure or unknown result is not a learned defeat.
            self.rejection = str(failure or "Unknown native outcome")
            self.outcome = "rejected"
            return 0.0
        if not replay_verified:
            self.rejection = "Native replay metadata was not verified"
            self.outcome = "rejected"
            return 0.0
        self.outcome = "time_limit" if time_limited else outcome
        self.collector.finish(self.outcome)
        return self.collector.take()

    def report(self):
        return {
            "schema": SCHEMA, "session_id": self.session_id,
            "checkpoint_sha256": self.checkpoint_sha256,
            "reward_config": self.config.to_dict(),
            "reward_config_sha256": canonical_sha256(self.config.to_dict()),
            "camera_restricted": True, "fog_restricted": True, "max_paid_apm": 200,
            "closed": self.closed, "outcome": self.outcome, "rejection": self.rejection,
            "receipts": deepcopy(self.receipts), "summary": self.collector.engine.summary(),
            "receipt_status": "rejected" if self.rejection else "provisional",
            "terminal_callback_accepted": self.closed and self.rejection is None,
            "terminal_source": "SC2 callback; replay metadata checked, player result not independently compared",
            "native_reward_evidence_accepted": False,
            "host_final_integrity_verified": False,
            "required_before_consumption": ["host final paid-input audit", "pinned source/checkpoint integrity",
                                            "native replay and terminal-result verification"],
            "eligible_for_policy_optimization": False, "optimizer_updates": 0,
            "actor_input_modified": False, "policy_gradient_connection_verified": False,
        }


class RewardedPredictionDriver(PredictionDriver):
    """Collect once on every stepped frame, including paid selection/camera waits."""
    def __init__(self, *args, feedback, **kwargs):
        super().__init__(*args, **kwargs)
        self.feedback = feedback

    async def step(self, bot, frame):
        receipt = self.feedback.observe(bot, frame)
        self.emit("neural_reward_observed", **receipt)
        return await super().step(bot, frame)


class RewardedAlphaStarLiveBot(AlphaStarLiveBot):
    """Explicit opt-in class; existing hosts do not silently change behavior.

    Native activation remains gated by the host's engine lease, background-only
    launch, observation and paid-input checks. This module starts no process.
    """
    def __init__(self, output, config, client, *, reward_config=None, **kwargs):
        super().__init__(output, config, client, **kwargs)
        self.reward_feedback = NeuralRewardFeedback(
            session_id=config["session_id"], checkpoint_sha256=config["checkpoint_sha256"],
            reward_config=reward_config)
        self.driver = RewardedPredictionDriver(
            client, session_id=config["session_id"], checkpoint_sha256=config["checkpoint_sha256"],
            emit=self.emit, feedback=self.reward_feedback)

    async def on_end(self, game_result):
        if self.reward_feedback.closed:
            return
        await super().on_end(game_result)
        terminal = self.reward_feedback.finish(
            game_result.name.lower(), time_limited=self._time_limited,
            failure=self.preview_failure or self.error,
            replay_verified=self.replay_validation.get("verified") is True)
        report = self.reward_feedback.report()
        report["native_replay_validation"] = deepcopy(self.replay_validation)
        report["terminal_reward_delta"] = terminal
        report["feedback_source_sha256"] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
        target = self.output / "neural-rewards.json"
        with target.open("x", encoding="utf-8") as stream:
            json.dump(report, stream, indent=2, allow_nan=False)
            stream.write("\n")
        self.emit("neural_reward_episode_closed", outcome=report["outcome"],
                  terminal_reward=terminal, optimizer_updates=0)
