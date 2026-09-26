# Third-party provenance

The local runtime source is licensed under the accompanying MIT LICENSE.

The optional structured imitation scripts import unmodified modules from
[Google DeepMind AlphaStar](https://github.com/google-deepmind/alphastar),
commit `700b1e74364ed5dfc66f6cd2574c5ffac2fa474e`, licensed Apache-2.0.
That source is preserved under `references/alphastar-upstream` with its
original copyright/license notices. No champion parameters or replay corpus
are redistributed here. This integration is independent of DeepMind/Blizzard.

The Windows game runtime uses BurnySC2, PyTorch, NumPy, s2protocol, sc2reader,
filelock, loguru, mpyq, protocol bindings and psutil as specified in
`pyproject.toml`. These dependencies keep their respective licenses and are
installed in the optional environment, not bundled into the normal agent.
See `MICRO_SOURCES.md` and `RESEARCH.md` for implementation references.
