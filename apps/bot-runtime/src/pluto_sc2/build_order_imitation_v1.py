"""Causal own-command sequence prior; never a game controller or spatial policy.

Replay ability links are replay tokens, not native SC2 ability IDs. This module
uses only the player's earlier issued command tokens and their timestamps.
Names, outcomes, spectator states and future build labels are not inputs.
"""

from __future__ import annotations

import math

import numpy as np
import torch
from torch import nn

SCHEMA = "own-command-build-prior-v1"
CAPACITY = 512
HISTORY = 32


def token_key(command):
    values = (command["ability_link"], command["command_index"])
    if any(type(v) is not int or not 0 <= v <= 65535 for v in values):
        raise ValueError("Invalid original replay command token")
    return ":".join(map(str, values))


def validate_record(record):
    if record["race"] not in ("Protoss", "Terran", "Zerg"):
        raise ValueError("Unsupported race")
    if record["partition"] not in ("train", "validation"):
        raise ValueError("Missing whole-replay partition")
    previous = (-1, -1)
    for command in record["commands"]:
        token_key(command)
        order = (command["game_loop"], command["source_event_index"])
        if any(type(v) is not int or v < 0 for v in order) or order <= previous:
            raise ValueError("Command order is not strictly causal")
        previous = order
    if not record["commands"]:
        raise ValueError("Empty command sequence")


def extend_vocabulary(records, existing=None):
    """Append TRAIN tokens into reserved slots without resizing any parameters."""
    result = dict(existing or {})
    if sorted(result.values()) != list(range(2, len(result) + 2)):
        raise ValueError("Vocabulary slot assignments changed")
    extra = sorted(
        {token_key(c) for r in records if r["partition"] == "train" for c in r["commands"]} - result.keys()
    )
    if len(result) + len(extra) + 2 > CAPACITY:
        raise ValueError("Reserved token capacity exceeded; explicit migration required")
    for key in extra:
        result[key] = len(result) + 2
    return result


def prefix_example(record, target_index, vocabulary):
    """Return history ending strictly before the target command, with BOS at t0."""
    commands = record["commands"]
    if not 0 <= target_index < len(commands):
        raise ValueError("Target index outside sequence")
    before = target_index
    while before > 0 and commands[before - 1]["game_loop"] >= commands[target_index]["game_loop"]:
        before -= 1
    prefix = commands[max(0, before - HISTORY) : before]
    tokens = np.zeros(HISTORY, np.int64)
    times = np.zeros((HISTORY, 2), np.float32)
    start = max(0, before - HISTORY)
    if not prefix:
        tokens[0] = 1  # Explicit beginning, not an unknown action.
        length = 1
    else:
        for index, command in enumerate(prefix):
            tokens[index] = vocabulary.get(token_key(command), 0)
            original_index = start + index
            preceding_loop = commands[original_index - 1]["game_loop"] if original_index else 0
            seconds = command["game_loop"] / 22.4
            gap = (command["game_loop"] - preceding_loop) / 22.4
            times[index] = (seconds / 600, math.log1p(gap) / 5)
        length = len(prefix)
    last_loop = commands[before - 1]["game_loop"] if before else 0
    wait = (commands[target_index]["game_loop"] - last_loop) / 22.4
    return tokens, times, length, vocabulary.get(token_key(commands[target_index]), -1), math.log1p(wait)


def collate_examples(examples):
    columns = list(zip(*examples))
    return (
        torch.tensor(np.stack(columns[0]), dtype=torch.long),
        torch.tensor(np.stack(columns[1]), dtype=torch.float32),
        torch.tensor(columns[2], dtype=torch.long),
        torch.tensor(columns[3], dtype=torch.long),
        torch.tensor(columns[4], dtype=torch.float32),
    )


class BuildOrderPrior(nn.Module):
    def __init__(self):
        super().__init__()
        self.embedding = nn.Embedding(CAPACITY, 24, padding_idx=0)
        self.memory = nn.GRU(26, 64, batch_first=True)
        self.next_token = nn.Linear(64, CAPACITY)
        self.next_wait = nn.Linear(64, 1)

    def forward(self, tokens, times, lengths, vocabulary_size):
        features = torch.cat((self.embedding(tokens), times), dim=-1)
        packed = nn.utils.rnn.pack_padded_sequence(
            features, lengths.cpu(), batch_first=True, enforce_sorted=False
        )
        _, hidden = self.memory(packed)
        logits = self.next_token(hidden[-1])
        mask = (torch.arange(CAPACITY, device=logits.device) >= 2) & (
            torch.arange(CAPACITY, device=logits.device) < vocabulary_size + 2
        )
        logits = logits.masked_fill(~mask, -1e9)
        return logits, torch.nn.functional.softplus(self.next_wait(hidden[-1]).squeeze(-1))


def imitation_loss(logits, predicted_wait, target, target_wait):
    known = target >= 2
    if not bool(known.all()):
        raise ValueError("Training target outside TRAIN vocabulary")
    commands = nn.functional.cross_entropy(logits, target)
    timing = nn.functional.smooth_l1_loss(predicted_wait, target_wait)
    return commands + 0.1 * timing, commands, timing
