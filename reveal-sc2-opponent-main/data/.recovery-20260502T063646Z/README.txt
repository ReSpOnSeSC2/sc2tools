MyOpponentHistory.json corruption recovery -- 2026-05-02 06:36:53 UTC

Symptom: opponents page only showed today's matches.
Root cause: data/MyOpponentHistory.json had been truncated to its first
balanced JSON object (6 opponents, 45,184 bytes) with the rest of the
file (27.7 MB) replaced by trailing whitespace. Likely cause: an in-place
write that did not truncate the destination file before writing the new
(shorter) content. The PowerShell scanner's atomic-write helper
(Write-FileAtomic in Reveal-Sc2Opponent.ps1) writes tmp + Move-Item but
something between writes reverted the destination to padded.

Recovery:
  - Salvaged the 6 surviving opponents from the corrupt file by slicing
    to the first balanced top-level dict (bytes 0..45184).
  - Loaded MyOpponentHistory.json.pre-merge-unknown-20260501T143757Z as the base (3178 opponents, 11,020 game records).
  - Merged per-opponent: for matchups present in both, kept the union of
    games (deduped on (Date, Map, Result)) and max(Wins, Losses).
  - Wrote merged result atomically and verified parseability.

Final: 3183 opponents, 11,033 game records.
