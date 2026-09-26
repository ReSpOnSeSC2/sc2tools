# Research decisions

Reviewed September 24, 2026. This is an original implementation with a small
local training budget; it is not a reproduction of either research system.

## Pluto

Vegard Mella's [technical README](https://davechurchill.ca/starcraft/cog/results/2026/PLUTO_README.txt)
describes his Brood War system. The [public repository](https://github.com/tscmoo/pluto)
contains documentation and binaries. The available material is not a formal paper
or a released training source tree.

This project's self-play uses two copies of the current policy and updates from
both completed trajectories. Its compact model, replay importer, macro execution
helpers and strict spatial input interface are newly written components.

## AlphaStar

Source: Vinyals et al., [Grandmaster level in StarCraft II using multi-agent
reinforcement learning](https://www.nature.com/articles/s41586-019-1724-z), Nature
575, 350-354 (2019), [author-hosted full paper](https://storage.googleapis.com/deepmind-media/research/alphastar/AlphaStar_unformatted.pdf).
Read the main paper, methods and extended data. Methods sections “Reinforcement
Learning” and “Exploration and diversity” motivate an undiscounted terminal
outcome and a supervised-policy KL penalty during RL. These complement our
existing replay initialization and monitored camera interface.

Our adaptations:

- Default `gamma=1.0` preserves the terminal win/loss objective. GAE and PPO
  remain this project's optimizer; this is not AlphaStar's off-policy algorithm.
- A frozen copy of the initial replay-trained policy supplies a masked
  `KL(reference || current)` regularizer on live rollout observations. The
  coefficient is configurable. This encourages retention of replay behavior;
  it does not guarantee that a weak initial behavior will improve.
- The reference is saved inside RL checkpoints so resume uses the original
  teacher. It receives the same restricted observation and legal mask as the
  current policy. There is no privileged opponent input to either network.
- The hard limit remains 200 actual inputs per rolling minute. Selection,
  command and camera events are counted separately. Our settings are the user's
  contract, not AlphaStar's published action budget.

The implementation does not claim AlphaStar's entity transformer, persistent
LSTM memory, autoregressive unit/target decoder, strategy conditioning, full
league with exploiters, or distributed training scale. Four-frame history and
deterministic target helpers have clear limits for long-term scouting and micro.
Those changes require separate data contracts and match validation.

Local read-only source: `references/AlphaStar_unformatted.pdf` (2,140,290 bytes).
SHA-256: `38158fb98af669ded78b55886af75cd46f16c3af9c9e66146da634e424a0db08`.
The original paper is excluded from source distributions.
