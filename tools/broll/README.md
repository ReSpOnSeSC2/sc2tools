# B-roll curation helper

This is the repeatable, local review workflow for turning your own YouTube Live
archives into SC2 Tools b-roll entries. It downloads only a low-resolution review
copy; the final Stream Dock library still references the original YouTube video
and exact start/end times.

The helper always uses this repository's `.venv` executables:

- `.venv/Scripts/yt-dlp.exe` (or `.venv/bin/yt-dlp`)
- the FFmpeg binary bundled inside `imageio_ffmpeg`

No system-wide install is required.

## Included Response Gaming reel

This workspace already includes the first curated library:

- `response-gaming-vods.json` — the editable source with 12 landscape VODs,
  three paired vertical simulcasts, 56 selected ranges, and review notes.
- `response-gaming-broll.json` — the ready-to-import Stream Dock file (53:48
  total playback, including 10 landscape/portrait paired highlights).

In the Stream Dock, open **Scenes → Manage highlight library**, choose the
ready-to-import JSON file, then click Starting Soon or BRB. To extend it later,
append a new video to `response-gaming-vods.json`, run `prepare` for lightweight
review media, add the selected ranges, and rerun `emit`.

## Fast workflow

1. Copy `vods.example.json` somewhere convenient and replace the placeholder IDs.
   Bare IDs, `youtube.com/watch` links, `youtube.com/live` links, and `youtu.be`
   links are accepted.
2. Check what the helper sees without writing anything:

   ```powershell
   .\.venv\Scripts\python.exe tools\broll\broll.py list path\to\vods.json
   .\.venv\Scripts\python.exe tools\broll\broll.py prepare path\to\vods.json --dry-run
   ```

3. Prepare 360p proxies and contact sheets. If YouTube needs your signed-in
   session, add `--cookies-from-browser chrome` (or `edge`/`firefox`):

   ```powershell
   .\.venv\Scripts\python.exe tools\broll\broll.py prepare path\to\vods.json --cookies-from-browser chrome
   ```

4. Open `.tmp/broll-review/review.json`. Review the files named in each video's
   `proxy` and `contactSheets` fields, then add promising ranges to its `clips`
   array. Contact-sheet cells are row-major; their exact timestamps are listed in
   each sheet's `samples` array.
5. Validate and emit the Stream Dock import file:

   ```powershell
   .\.venv\Scripts\python.exe tools\broll\broll.py emit .tmp\broll-review\review.json
   ```

6. Import `.tmp/broll-review/broll-library.json` in the Stream Dock's B-roll
   Library editor.

The next time you have a stream, append its ID to the source manifest and run
`prepare` again. Existing proxies and sheets are skipped, and clip selections and
notes already in `review.json` are preserved. This makes ongoing additions an
incremental operation instead of a fresh edit.

## Clip editing format

Both readable timecodes and raw seconds work. `end` can be replaced with
`duration`. Set `"include": false` to keep an idea in the review file without
exporting it.

```json
{
  "title": "Hold at the natural into the counterattack",
  "start": "1:12:08",
  "end": "1:13:02"
}
```

For a matching vertical simulcast, put `verticalVideoId` on the video and the
matching first frame on each clip. The emitted vertical source inherits the
landscape clip duration, so horizontal and vertical OBS canvases stay on the
same shared timeline:

```json
{
  "videoId": "HORIZONTAL1",
  "verticalVideoId": "VERTICAL123",
  "clips": [
    {
      "title": "Paired fight",
      "start": "17:30",
      "end": "18:15",
      "verticalStart": "19:53"
    }
  ]
}
```

The emitted file is deliberately minimal and compatible with the dock:

```json
{
  "version": 1,
  "clips": [
    {
      "id": "XXXXXXXXXXX-4328-4382",
      "title": "Hold at the natural into the counterattack",
      "videoId": "XXXXXXXXXXX",
      "startSeconds": 4328,
      "endSeconds": 4382,
      "vertical": {
        "videoId": "YYYYYYYYYYY",
        "startSeconds": 4471
      }
    }
  ]
}
```

The dock accepts at most 100 clips, titles up to 120 characters, and timestamps
below 24 hours. `emit` enforces those constraints before it writes anything.
Landscape-only records remain valid and are also the safe fallback when a
vertical source is absent.

## Useful options

- `--sheet-interval 90` samples more densely than the 180-second default.
- `--columns 5 --rows 4` puts 20 samples on each sheet.
- `--proxy-height 240` minimizes disk and download use for very long archives.
- `--max-filesize 750M` changes the per-video safety cap passed to yt-dlp.
- `--force` rebuilds cached derivatives. Changing sheet layout settings rebuilds
  sheets automatically, without re-downloading proxies.
- `list --json` emits machine-readable cache status for future automation.
- `emit --dry-run` validates and prints the final library without writing it.

Only download recordings you own or have permission to use. Proxies under
`.tmp/broll-review` are working files and are not used during the live broadcast.

## Smoke test

The test suite makes a tiny synthetic video with the bundled FFmpeg executable;
it never contacts YouTube:

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tools\broll -p "test_*.py" -v
```
