# SB3: Stream Guardian

**Shipped (PR stacked on #996, SB2).** Four optional warnings for a live stream, each with its own switch, all off: microphone muted for two minutes while live, frames dropping or the stream reconnecting, a game started with OBS neither streaming nor recording, still live on a break scene long after the last game. A warning is a silent tray notice and a banner in the Stream Dock, once per incident, cleared when the cause clears. Agent 0.26.0 (unchanged), ADR 0106.

**Decisions.**
- The agent decides and the server relays. `guardian_rules.py` holds pure state machines over OBS readings; `guardian_probe.py` makes the reads on its own `ObsConnection`; `guardian.py` runs the loop (own thread) and pushes the active list.
- Cost: no OBS request while every switch is off; each read asks only what the switches on need. While not live with a live-only rule on, a few reads per 15 s only to notice going live; at most five per 5 s while live or in a game; the game rule alone reads only while a game runs. A stream through a named plugin output (Aitum) counts as live and captured; the virtual camera and replay buffer do not.
- Review fixes: a failed read is believed only after three in a row; the Dock push runs on its own thread; a saved microphone OBS lacks is shown on the card; the Dock ages a replayed list by the server `ageMs`; the banner is a polite status region with the minutes aria-hidden; turning every switch off forgets the rule clocks.
- Break scenes are found by name (BRB, break, starting soon, intermission, AFK, away): no fifth setting. Unreachable OBS is "unknown" and never warns.
- Dock path: `POST /v1/agent/streaming/guardian` keeps the newest list per user in memory, emits `overlay:guardian` to `user:<id>` and replays it to a Dock that connects. The agent repeats an unchanged list each minute; server and Dock forget a list after three minutes. Nothing is stored in the database.
- Silence: `TrayUI.show_quiet_notice` sends the Windows balloon with `NIIF_NOSOUND` through pystray's `_message` (private API; falls back to the plain notice off Windows). Respects the "notifications muted" setting.

**Not verified.** No live OBS (`GetInputMute`, `GetStreamStatus` field names, `get_current_program_scene` attribute name are from the obs-websocket 5 documentation and `obsws_python` naming, read through fakes only), no Windows balloon run (whether `NIIF_NOSOUND` silences a Windows 11 toast), no live Dock socket. The Streams page was checked offscreen only.

**Owner checks.** Mute the microphone for two minutes while live; start a game without going live.

**Tests.** Agent 69 guardian tests plus 4 Guardian page tests; API 5 suites 78 tests; web dock and multichat 61 files 537 tests. Review pass: 10 of 10 mutations killed (record `.cache/round3-SB3-tools/mutation-02`). Local `perf:budget` reads /dock/[token] 225.7 / 225 (CI about 1.2 kB lower); /overlay and /guides/[matchup]/[build] also read over locally and import nothing changed here.

**Known.** `tests/test_streams_desktop_theme.py::test_stream_setup_and_obs_controls_fit_the_smallest_display` fails on the SB2 base too (page minimum width 454 against 425): the title checkboxes added in SB1/SB2 are wider than the smallest display. The Guardian card's checkbox labels are shorter than those.
