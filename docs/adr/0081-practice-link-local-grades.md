# ADR 0081 · Practice Links and local grades

Status: Accepted, November 11, 2026.

Practice Links use an owner-curated file to map one readable alias to one published Community build. The route reads the current public build and creator on every visit under ADR 0074. A withdrawn or anonymous publication removes access to its Practice Link.

To publish an alias, verify the owner’s public build slug and creator label, the matching YouTube ID, the video time when the replay clock starts, the build’s recorded patch era, and the cutoff for grading. Add that record to `apps/web/lib/practice/practiceLinks.json`. `before` denotes the eight-worker 5.0.16 era and `after` the twelve-worker era. Select a video that shows the same reference build and confirm the offset by comparing a recorded step to the video.

YouTube loads on explicit play or seek. Drill uses browser speech and a screen wake lock where available. Grade uses the existing one-file browser session and accepts one human 1v1 replay on desktop Chromium. It compares timed structures and upgrades from a recorded order. A result below half the recorded steps is a mismatch.

The replay and grade stay in memory. A visitor can share a card containing the letter and public creator credit. Analytics counts a delivered card using its fixed kind, method and normalized path. ADR 0042 and ADR 0060 continue to govern coaching and saved-game evidence.

The initial registry is empty. Current owner builds with recorded steps have no verified matching video, offset and recorded era in the published inventory.
