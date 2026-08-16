from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path

import broll


class ManifestTests(unittest.TestCase):
    def write_manifest(self, directory: Path, document: object) -> Path:
        path = directory / "vods.json"
        path.write_text(json.dumps(document), encoding="utf-8")
        return path

    def test_loads_ids_and_common_urls(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = self.write_manifest(
                Path(temporary),
                {
                    "videos": [
                        "ABCDEFGHIJK",
                        {"url": "https://www.youtube.com/live/123456789_-?feature=share"},
                    ]
                },
            )
            self.assertEqual(
                [vod.video_id for vod in broll.load_manifest(path)],
                ["ABCDEFGHIJK", "123456789_-"],
            )

    def test_emits_exact_dock_schema_and_skips_excluded_clips(self) -> None:
        vod = broll.Vod(
            video_id="ABCDEFGHIJK",
            title="Ladder night",
            source_url="https://www.youtube.com/watch?v=ABCDEFGHIJK",
            clips=[
                {"title": "Big hold", "start": "1:02:03", "duration": "0:45"},
                {"title": "Maybe later", "start": 10, "end": 20, "include": False},
            ],
        )
        self.assertEqual(
            broll.build_clip_library([vod]),
            {
                "version": 1,
                "clips": [
                    {
                        "id": "ABCDEFGHIJK-3723-3768",
                        "title": "Big hold",
                        "videoId": "ABCDEFGHIJK",
                        "startSeconds": 3723,
                        "endSeconds": 3768,
                    }
                ],
            },
        )

    def test_generated_id_is_backend_safe_for_leading_punctuation_video_id(self) -> None:
        vod = broll.Vod(
            video_id="-HVdPDIfox4",
            title="Ladder night",
            source_url="https://www.youtube.com/watch?v=-HVdPDIfox4",
            clips=[{"title": "Beams Through the Swarm", "start": 845, "end": 915}],
        )

        clip = broll.build_clip_library([vod])["clips"][0]

        self.assertEqual(clip["id"], "clip--HVdPDIfox4-845-915")
        self.assertIsNotNone(broll.CLIP_ID_RE.fullmatch(clip["id"]))
        self.assertEqual(clip["videoId"], "-HVdPDIfox4")

    def test_rejects_backwards_range(self) -> None:
        vod = broll.Vod(
            video_id="ABCDEFGHIJK",
            title="",
            source_url="https://www.youtube.com/watch?v=ABCDEFGHIJK",
            clips=[{"start": 20, "end": 10}],
        )
        with self.assertRaisesRegex(broll.BrollError, "must end after"):
            broll.build_clip_library([vod])

    def test_rejects_non_finite_numeric_time(self) -> None:
        with self.assertRaisesRegex(broll.BrollError, "outside the supported range"):
            broll.parse_timecode(float("nan"), "clip start")


class MediaCommandTests(unittest.TestCase):
    def test_contact_sheet_with_bundled_ffmpeg(self) -> None:
        ffmpeg = broll.resolve_ffmpeg()
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            video = directory / "synthetic.mp4"
            subprocess.run(
                [
                    str(ffmpeg),
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-f",
                    "lavfi",
                    "-i",
                    "testsrc2=size=320x180:rate=2",
                    "-t",
                    "5",
                    "-c:v",
                    "mpeg4",
                    "-y",
                    str(video),
                ],
                check=True,
            )
            command = broll._sheet_command(
                ffmpeg,
                video,
                directory / "sheet-%03d.jpg",
                interval=1,
                width=160,
                columns=2,
                rows=2,
            )
            broll._run(command, dry_run=False)
            sheets = sorted(directory.glob("sheet-*.jpg"))
            self.assertGreaterEqual(len(sheets), 1)
            self.assertTrue(all(sheet.stat().st_size > 0 for sheet in sheets))

    def test_prepare_dry_run_does_not_create_review_directory(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            manifest = directory / "vods.json"
            manifest.write_text(json.dumps({"videos": ["ABCDEFGHIJK"]}), encoding="utf-8")
            review = directory / "does-not-exist"
            status = broll.main(
                [
                    "prepare",
                    str(manifest),
                    "--review-dir",
                    str(review),
                    "--dry-run",
                ]
            )
            self.assertEqual(status, 0)
            self.assertFalse(review.exists())

    def test_prepare_preserves_existing_clip_work_when_assets_are_cached(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            manifest = directory / "vods.json"
            manifest.write_text(json.dumps({"videos": ["ABCDEFGHIJK"]}), encoding="utf-8")
            review = directory / "review"
            (review / "proxies").mkdir(parents=True)
            (review / "sheets").mkdir()
            (review / "proxies" / "ABCDEFGHIJK.mp4").write_bytes(b"cached proxy")
            (review / "sheets" / "ABCDEFGHIJK-sheet-001.jpg").write_bytes(b"cached sheet")
            selected_clip = {"title": "Keep me", "start": "1:00", "end": "1:45"}
            (review / "review.json").write_text(
                json.dumps(
                    {
                        "sampleEverySeconds": 180,
                        "sheetColumns": 4,
                        "sheetRows": 3,
                        "sheetCellWidth": 320,
                        "videos": [
                            {
                                "videoId": "ABCDEFGHIJK",
                                "title": "Existing review",
                                "clips": [selected_clip],
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )
            status = broll.main(
                ["prepare", str(manifest), "--review-dir", str(review)]
            )
            self.assertEqual(status, 0)
            updated = json.loads((review / "review.json").read_text(encoding="utf-8"))
            self.assertEqual(updated["videos"][0]["clips"], [selected_clip])


if __name__ == "__main__":
    unittest.main()
