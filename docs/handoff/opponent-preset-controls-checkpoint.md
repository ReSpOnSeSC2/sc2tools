# Opponents preset and phone sort correction: locally verified

Based on locally tested `f0faac0b4d16c1914b50d793d72e9e6e2e0fa5d2`, whose web
source matches delivered `0b90c1b8a3b96f0b748da539b291f7878574023d`.
The parent later merged as `0eb06c18e5d5743e7230e4b4db41553fca6e363f` with
the same content tree. This branch has not been advanced over its own work.

The owner reported that Lost to most changed the list while All opponents
stayed selected, and phone controls then appeared stuck. The source confirmed
two mismatches: the quick action stored `all` while changing the sort to
losses; the phone menu omitted losses/wins and displayed Last played instead
of that actual loss sort. Clicking the already-selected All action could not
reset the sort, and choosing the falsely displayed Last played option could
produce no native change.

Two production files change. Lost selection is derived from the existing
quick scope and loss-descending sort, including URL/device restoration. All
explicitly restores newest-first sorting. The phone menu gains Wins/Losses;
the other existing core/detail options remain present and Net MMR stays
deduplicated. The five quick-view buttons are a small private component in
the same file, keeping the new derived branches out of the existing long tab
function without compressing its source. No shared URL hook, global/account filter, grouping preference,
saved column, data query or ranking semantics change.

A new consumer regression mounts the actual Tab, History, controls, sort and
URL writer, with only navigation transport and GET/account providers as seams.
It covers the preset/All exit, actual row order, native sort selection and
direction, canonical option parity, URL/legacy/Back/device restoration,
independent quick filters and desktop headers. Existing tests are unchanged.
Current local verification passed 179 tests in 14 files, including all 27 new
consumer cases; whole-web nonincremental types and scoped lint passed with no
added diagnostics. Build `QDShh4TdDS3gDMJTLw3JA` passed all 83 unchanged budgets.
Two browser cases (390px light and 1280px dark) passed with four full-default
Axe scans reporting zero violations. All 7,007 source inputs and the original
engine/assets/sample guards stayed exact. Owned processes/listeners settled. The quick-view label has a semantic group
role; its Axe incomplete finding is resolved. Eighteen arrow-only glyph
observations retain their manual-review qualification (minimum computed
foreground/background contrast 6.01:1).

LOCAL fixture captures use synthetic account/HTTP data and explicit Next and
dossier boundaries. They establish consumer behavior, native sort selection,
row order, browser Back/reload and accessibility in those fixtures; live phone
or real Next routing acceptance is not claimed. Exact-head CI, deployment and
signed-in production acceptance remain required.

The separate Pulse source stays preserved and held. No provider, native,
cache activation, flag, infrastructure, engine asset or roadmap-count change
is included. The program remains active and incomplete at 124 completed,
53 partial and 20 open original items (73 unfinished).
