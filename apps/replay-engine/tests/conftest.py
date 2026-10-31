"""Load the real sc2reader before any test module can stub it.

Many test modules park ``MagicMock`` stand-ins for ``sc2reader`` in
``sys.modules`` at import time so they still import on machines without
sc2reader (``sys.modules.setdefault(...)``, or the
``if 'sc2reader' not in sys.modules`` guard in tests/db/test_migrations.py).
pytest imports every test module before running any test, so once the
first shim was collected the whole session ran against stubs:
``core.sc2_replay_parser`` and test_worker_events.py's real-replay fixture
bound a ``MagicMock`` instead of the pinned package
(requirements-server.txt). Importing the real package here, ahead of
collection, turns those shims into no-ops whenever sc2reader is installed.
Tests that need fake event classes still install them explicitly while
they run.
"""
try:
    import sc2reader  # noqa: F401  (imported for its sys.modules entries)
except ImportError:  # pragma: no cover - the per-module shims take over
    pass
