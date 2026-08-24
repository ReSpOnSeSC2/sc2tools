# SC2 Tools Coaching — pipeline & packet kit

Boutique Protoss coaching built on the SC2 Tools replay engine. Start with
`COACHING_PLAYBOOK.md` (the program design); this folder is the working kit.

## The loop

```
parsed.jsonl (replay engine output over YOUR ladder replays)
   │
   ▼  each season
python extract_builds.py parsed.jsonl -o coaching_builds.json \
       --season 68 --season-start 2026-06-01 --min-games 4
   │        (current-season exemplars preferred; otherwise newest on record,
   │         flagged from_current_season=false)
   ├──────────────────────────────────────────────┐
   ▼                                              ▼
python make_packet.py students/<name>/profile.json   python make_library_page.py \
       --refs coaching_builds.json --pdf packet.pdf         coaching_builds.json -o build_library.html
  (per-student branded PDF packet)                   (student-facing web build library)

student submits replay.SC2Replay
   ▼
python grade_replay.py replay.SC2Replay --refs coaching_builds.json \
       --player <StudentName> --build <assigned-build-id>
  -> terminal summary, .grade.json (their longitudinal record), .report.html (branded card)
```

## Notes

- `grade_replay.py` needs `sc2reader==1.8.0` in a clean venv (see repo README — never system pip).
- Grade against the **assigned** build with `--build`; auto-match is a convenience and can
  confuse close PvP variants.
- Grading covers the opening window (default 8:00). Grace ±12s, zero credit at 90s,
  buildings ×2, upgrades ×1.5.
- Keep every `.grade.json` per student — that accumulating history is the
  adherence-trend / progress-report data.
- Season rollover SOP is §5 of the playbook.

## Files

- `extract_builds.py` — parsed.jsonl → coaching_builds.json (reference builds + median benchmarks)
- `grade_replay.py` — the Build Execution Grader (flagship between-session value-add)
- `make_packet.py` — per-student opening packet, HTML + PDF
- `make_library_page.py` — build_library.html (host on sc2tools.com or share the artifact)
- `students/DemoStudent/` — sample profile + generated packet
- `sample-report-card.html` / `sample-grade.json` — grader output on a real replay
  (Old Republic LE, PvZ Stargate into Glaives, graded A 93.3)
