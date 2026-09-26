"""Versioned own-HUD residual over an immutable causal command prior.

No tracker parsing, target labels, gameplay control, or base optimization lives
here. The caller must supply the independently admitted eight HUD features.
"""
from __future__ import annotations

import torch
from torch import nn

from pluto_sc2.build_order_imitation_v1 import BuildOrderPrior, CAPACITY

SCHEMA = "own-command-hud-prior-v1"
FEATURES = 8


class HudResidualPrior(nn.Module):
    def __init__(self, base_parameters):
        super().__init__()
        # Creating modules must not silently consume the inherited RNG stream.
        rng = torch.get_rng_state()
        self.base = BuildOrderPrior()
        self.base.load_state_dict(base_parameters, strict=True)
        self.base.requires_grad_(False)
        self.base.eval()
        self.adapter = nn.Linear(FEATURES, CAPACITY, bias=False)
        nn.init.zeros_(self.adapter.weight)
        torch.set_rng_state(rng)

    def train(self, mode=True):
        super().train(mode)
        self.base.eval()
        return self

    def forward(self, tokens, times, lengths, vocabulary_size, hud):
        if (hud.dtype != torch.float32 or hud.shape != (tokens.shape[0], FEATURES)
                or not bool(torch.isfinite(hud).all())
                or not 1 <= vocabulary_size <= CAPACITY - 2):
            raise ValueError("Invalid admitted HUD feature tensor or vocabulary")
        if bool(((hud[:, 4:] != 0) & (hud[:, 4:] != 1)).any()):
            raise ValueError("HUD missingness indicators must be binary")
        known = hud[:, 4:7].any(-1)
        if (not torch.equal(known, hud[:, 7].bool())
                or bool((hud[~known] != 0).any())
                or bool((hud[:, :3].masked_select(~hud[:, 4:7].bool()) != 0).any())):
            raise ValueError("Missing-all HUD must be exactly zero")
        with torch.no_grad():
            logits, wait = self.base(tokens, times, lengths, vocabulary_size)
        residual = self.adapter(hud)
        mask = (torch.arange(CAPACITY, device=logits.device) >= 2) & (
            torch.arange(CAPACITY, device=logits.device) < vocabulary_size + 2)
        # Reapply the exact original mask: residuals may never unmask a token.
        return (logits + residual).masked_fill(~mask, -1e9), wait


def verify_frozen_base(model, original_parameters):
    actual = model.base.state_dict()
    if (actual.keys() != original_parameters.keys()
            or any(p.requires_grad or p.grad is not None for p in model.base.parameters())
            or any(a.dtype != original_parameters[k].dtype or a.shape != original_parameters[k].shape
                   or a.detach().cpu().contiguous().numpy().tobytes() != original_parameters[k].detach().cpu().contiguous().numpy().tobytes()
                   for k, a in actual.items())):
        raise ValueError("Frozen base parameters changed or acquired gradients")
