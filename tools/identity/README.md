# Replay identity retrieval audit

This offline audit uses real `.SC2Replay` files and the production extractor,
signature validator, and matcher. It never uploads replay data or creates
example players. The source replay files remain unchanged.

From the repository root on Windows:

```powershell
& .venv/Scripts/python.exe tools/identity/extract_corpus.py calibration-replays --limit 60 --output output/identity-corpus.json
node tools/identity/evaluate_corpus.cjs output/identity-corpus.json output/identity-evaluation.json
```

Use `--limit 1000` to cover a larger local corpus. Metadata scanning is capped
at 5,000 files by default; `--max-files` accepts up to 20,000. Only the selected
files receive full event parsing. Nonhuman and non-1v1 games, resumed replays,
games shorter than two minutes, missing account/race metadata, and exact file
duplicates are excluded. Parse failures and exclusions appear in the report.

The extractor excludes an account present in at least half the corpus, when
one exists, to prevent the local player's many repeated replays from inflating
retrieval. The bounded sample favors opponents with at least two replays.
Account handles become SHA-256 labels; names, account handles, and those labels
never enter the feature scorer. Output contains local behavioral evidence and
should be kept with the user's private replay data.

The evaluator holds out the newest replay per account and race. Every held-out
replay hash is removed from every candidate profile. Each profile contributes
at most 24 remaining games, matching the production limit. Same-race candidates
are scored with the production matcher; build evidence uses the matchup. The
primary ranking uses production `rankScore`, then `patternMatch`, and the same
0.35 display threshold. Equal-score ties use the anonymous label because the
audit does not retain display names. Raw pattern ranking is reported separately.

Top-1/top-5 retrieval measures whether the same known account was retrieved
from another replay. It does **not** measure whether an unidentified alternate
account belongs to that person. There is no verified alternate-account ground
truth in this corpus, and no probability calibration is claimed. Different
accounts can belong to the same person; an other-account similarity collision
is consequently not proof of a false-person match. The report also shows how
often another account exceeds the display threshold, which helps reveal how
weak a raw similarity threshold is on its own.

This is a development audit that can guide implementation. A disjoint replay
split prevents reference/query leakage, but a corpus used to choose scoring
changes is not an untouched external benchmark for final accuracy claims.

The evaluator exits nonzero if any extracted signature fails lossless storage
validation or if no independent query/reference pairs exist. It does not enforce
an arbitrary accuracy threshold or substitute generated examples for missing data.
