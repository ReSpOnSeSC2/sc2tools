"""
SC2 Tools - Watchers
====================
Filesystem watchers that bridge live game events into the merged
toolkit. The replay watcher ingests new .SC2Replay files and the
MMR scanner watches the OCR'd MMR text file produced by the
overlay's screen scanner.

Note: submodules are NOT eagerly imported here. The previous version
re-exported `replay_watcher` and `sc2_mmr_scanner` at package import
time, which made `python -m watchers.replay_watcher` trigger a
``RuntimeWarning: 'watchers.replay_watcher' found in sys.modules
after import of package 'watchers', but prior to execution of
'watchers.replay_watcher'``. Importing them lazily avoids the
double-load. Callers should `from watchers import replay_watcher`
or `python -m watchers.replay_watcher` directly.
"""
