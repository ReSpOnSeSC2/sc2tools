from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from package_media import PackageError, require_sources


class RequireSourcesTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.source = self.root / "marine-skyfire"
        self.frames = self.source / "frames"
        self.frames.mkdir(parents=True)
        (self.source / "poster.png").write_bytes(b"poster")
        (self.frames / "frame_0001.png").write_bytes(b"one")
        (self.frames / "frame_0002.png").write_bytes(b"two")
        self.defaults = {"frameStart": 1}
        self.spec = {"id": "marine-skyfire", "frameEnd": 2}

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def write_ledger(self, *, ready: bool) -> None:
        payload = {
            "schemaVersion": 1,
            "specId": "marine-skyfire",
            "ready": ready,
            "effectGate": [] if ready else [
                {
                    "role": "hero",
                    "effectClass": "particle systems",
                    "unresolvedCount": 1,
                    "ready": False,
                }
            ],
        }
        (self.source / "effect-realization.json").write_text(
            json.dumps(payload), encoding="utf-8"
        )

    def test_requires_fidelity_ledger(self) -> None:
        with self.assertRaisesRegex(PackageError, "fidelity ledger is missing"):
            require_sources(self.root, self.defaults, self.spec)

    def test_rejects_unresolved_effects(self) -> None:
        self.write_ledger(ready=False)
        with self.assertRaisesRegex(PackageError, "particle systems=1"):
            require_sources(self.root, self.defaults, self.spec)

    def test_accepts_ready_ledger_and_complete_frames(self) -> None:
        self.write_ledger(ready=True)
        poster, frames, frame_start = require_sources(self.root, self.defaults, self.spec)
        self.assertEqual(poster, self.source / "poster.png")
        self.assertEqual(frames, self.frames)
        self.assertEqual(frame_start, 1)


if __name__ == "__main__":
    unittest.main()
