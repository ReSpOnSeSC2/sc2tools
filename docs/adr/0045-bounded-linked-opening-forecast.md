# ADR 0045: Bounded linked scouting and a deterministic opening forecast

Status: Accepted for implementation, 2026-10-25

Live scouting currently treats each character separately. The dossier and live
widgets use a two-tier recency heuristic, while the private desktop brief copies
the plain favourite-opening frequency. These are different questions presented
as one prediction.

Use one pure `openingForecast` over the newest 50 eligible personal matchup
games. At age i the replay contributes 2^(-i/8), multiplied by 1.5 on the current
map. Effective n is the sum of those personal weights. Confidence is Low below
3, Medium below 8, and High otherwise; a ladder prior never increases personal
confidence. Missing labels retain probability mass. The three displayed rows
are probabilities across all openings, with an explicit other-probability
field, rather than renormalising the displayed subset to 100%.

An existing k-floor Ladder Meta document contributes three pseudo-games. Its
stored openers describe the uploader's build, and its rating band describes the
opponent. Forecasting their build in your PvZ therefore reads ZvP at your rating
band. Without your rating or a suitable cached row there is no prior. This reads
cached derived metadata only; it never runs a corpus aggregate or upstream call.

The identity resolver uses approved identity edges and cached Battle.net account
links only, with indexed bounded reads and at most 20 owned opponent rows. It
never groups a bare name, warms Pulse links, enumerates all owner opponents, or
loads detail blobs. Current-toon notes remain separate from merged statistics.
The server preference and resolved group identity participate in cache identity;
owner preference and replay visibility changes invalidate pending cache writes.

The dossier, live envelope, overlay and private desktop brief consume the same
forecast result. Raw count-only reasons describe the last five meetings, games
on this map and the cached ladder share. Context and confidence remain visible;
the result is an explanation of replay history, not a read of the current game.

No model, ML endpoint, AI API, new infrastructure, production migration or
background corpus job is introduced. Validation uses disposable Mongo fixtures,
pure golden cases and local synthetic browser/native boundaries.
