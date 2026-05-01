@echo off
cd /d "C:\SC2TOOLS\reveal-sc2-opponent-main"
echo === Git remote ===
git remote -v
echo.
echo === Git status ===
git status --short
echo.
echo === Adding changed files ===
git add SC2-Overlay/widgets/scouting.html
git add stream-overlay-backend/public/voice-settings.html
git add data/config.json
git add data/config.schema.json
git add START_SC2_TOOLS.bat
git add roadmapfeaturesup.md
git add README.md
echo.
echo === Committing ===
git commit -m "feat: scouting voice readout + voice settings UI

- SC2-Overlay/widgets/scouting.html: Add Web Speech API TTS module
  that reads a natural-language scouting report aloud at game start.
  Reads opponent name/race, H2H record, rival/nemesis status, recent
  trend, cheese warning, and best-answer counter-build. Auto-cancels
  on match result. Chrome stall watchdog keeps OBS browser source alive.

- stream-overlay-backend/public/voice-settings.html: New settings page
  served at localhost:3000/voice-settings.html with volume, speed,
  pitch, delay, and voice-selector controls. Live test button plays a
  sample readout. Saves to data/config.json via PATCH /api/config.

- data/config.schema.json: Add 'voice' property block (enabled, volume,
  rate, pitch, delay_ms, preferred_voice). Not required so existing
  configs without the key still validate.

- data/config.json: Add voice defaults (enabled, volume 1.0, rate 0.95,
  pitch 1.0, delay 600ms, preferred_voice empty).

- START_SC2_TOOLS.bat: Open voice settings page as step 4/4 on launch.

- roadmapfeaturesup.md: 10-feature competitive roadmap vs sc2replaystats.

- README.md: Full rewrite covering the expanded toolkit, all widgets,
  voice readout, voice settings UI, and download link at top."
echo.
echo === Pushing ===
git push
echo.
echo Done. Press any key to close.
pause
