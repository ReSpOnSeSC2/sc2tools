# Public implementation and private local workspace

The implementation lives in `apps/bot-runtime`. The intended durable local data home is
`C:/SC2TOOLS/.local/bot-project/workspace`, excluded from Git. That local directory holds
replay originals, fixed split manifests, derived datasets, checkpoint generations,
evaluation receipts, STOP markers and historical notes. Neither Git nor the desktop
installer distributes those private assets.

Copying a project does not transfer ownership of its running processes. An existing
learner or mapper continues using its original paths until a separate, deliberate
handoff. Checkpoint provenance includes absolute input/source paths and hashes;
moving files does not make a resumed checkpoint valid at a different path. Preserve
the original location while its processes are active. Do not start the archived
learner merely because a copy exists.

The local archive should include:

- Original replays and whole-replay train/validation assignments.
- Completed derivatives, their source hashes and independent verification receipts.
- Immutable checkpoints, optimizer/RNG/cursor state and their pinned source snapshots.
- STOP files and a clearly timestamped snapshot of mutable status/log files.
- Research and failed-run evidence needed to explain selection decisions.

Do not copy credentials into the archive. Python environments, build outputs and test
caches can be reconstructed. Live process locks and unfinished temporary files are
not proof of a resumable run. Do not remove a STOP file or alter a split while copying.
The active agent's website mappings remain separate from player-visible observations.

## Inspect a source checkout safely

Create an independent Python environment for this package; keep it separate from the
desktop agent's environment. From `apps/bot-runtime`:

```powershell
python -m venv .venv
.venv/Scripts/python.exe -m pip install -e ".[dev]"
.venv/Scripts/python.exe scripts/verify_source_manifest.py
.venv/Scripts/python.exe scripts/train_build_order_hud_v1.py --help
```

The verifier checks controlled source bytes without launching models or games.
`SOURCE_MANIFEST.json` excludes itself to avoid a recursive hash. Private data and
locally generated outputs are not entries in that source manifest. An active run's
own receipt remains the authority for its original source/input versions.

See [continuous own-HUD imitation](CONTINUOUS_OWN_HUD.md),
[reward recording](REWARD_FEEDBACK.md), and
[the structured AlphaStar experiment](ALPHASTAR_FOUNDATION.md).

## Private website boundary

Keep `BOT_LAB_ENABLED` absent or false on both web and API deployments. The existing
administrator allowlist and separate local agent enablement remain required even
when the flags are enabled deliberately. This source package adds no public menu,
automatic game launch, model download or installer update. See
[the hidden integration guide](../../docs/bot-lab.md).
