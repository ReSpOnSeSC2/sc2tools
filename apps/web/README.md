# @sc2tools/web — cloud frontend

Next.js 15 App Router + Clerk + Tailwind, deployed on Vercel.

## Local dev

```bash
cd apps/web
npm install
cp .env.example .env.local
# Fill NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, CLERK_SECRET_KEY, NEXT_PUBLIC_API_BASE
npm run dev
# http://localhost:3000
```

## Routes

| Path                | Auth   | What                                   |
| ------------------- | ------ | -------------------------------------- |
| /                   | public | Landing                                |
| /sign-in, /sign-up  | public | Clerk's hosted UI                      |
| /download           | public | Agent install instructions             |
| /try                | public | Instant Analysis: in-browser replay report (flag-gated) |
| /app                | clerk  | Today dashboard + replay analysis      |
| /app/replays        | clerk  | Replay library and share controls      |
| /players/[slug]/replays | public | Shareable player replay list + downloads |
| /players/[slug]/replays/[gameId] | clerk | Shared replay analysis + macro |
| /devices            | clerk  | Pair / list / revoke agents             |
| /streaming          | clerk  | Overlay tokens                         |
| /builds             | clerk  | User's custom-build library            |
| /overlay/[token]    | token  | Public OBS Browser Source target       |

## Public community activity

The shared site and app headers display agent downloads, active agents, and
users online. The counts refresh every 30 seconds from `/api/site/stats`, which
proxies the API's public aggregate endpoint. Missing or unavailable counts show
a dash, never an invented zero. The expandable explanation defines each metric.
Broadcast overlay and stream dock routes do not display or report presence.

`SitePresence` sends a check-in once a minute while a page is visible and has
not been idle for three minutes. `/api/site/presence` keeps the API-signed
browser token in a three-minute HttpOnly cookie. Clerk JWTs let the API count
signed-in accounts once across devices; anonymous visits count once per browser.
No page history or raw account identifiers are stored in presence records.

Deploy both `apps/api` and `apps/web` for this feature. Existing API base URL,
Clerk, MongoDB, and server pepper configuration are sufficient; the API creates
the presence indexes at startup. See the API README's public site activity
section for source definitions, retention, and rate limits.

## Instant Analysis (in-browser replay parsing)

`/try`, the signed-in browser importer and Folder Sync parse replays on the
visitor's device. A Web Worker runs the desktop agent's own Python pipeline
under self-hosted Pyodide. Design, parity rules, upload and storage
behaviour, the R2 CORS rule for replay backup and the rollout plan are in
[`docs/instant-analysis.md`](../../docs/instant-analysis.md) and
[ADR 0022](../../docs/adr/0022-instant-analysis-browser-parsing.md). Code
lives in `lib/instant/`, `components/instant/` and `app/try/`.

### Engine build

The engine is generated, not committed. `scripts/build-browser-engine.mjs`
writes `public/pyodide/<pyodideVersion>/` (the Pyodide runtime, copied from
the pinned npm package) and
`public/engine/<engineVersion>/<bundleId>/{engine.zip,manifest.json}`, plus
the pointer `public/engine/current.json`. Both directories are gitignored.

```bash
npm run engine:build   # build it now; any failure is an error
npm run build          # the prebuild hook runs the same script first
```

The build needs Python ≥ 3.10 with `venv` and `ensurepip` (Debian/Ubuntu:
`python3-venv`).
It tries `$PYTHON`, then `python3`, then `python`. It builds hash-pinned
sc2reader and mpyq wheels in a private venv under
`node_modules/.cache/sc2tools-browser-engine/` (cached), assembles a
deterministic `engine.zip` inside Pyodide, smoke-parses a fixture replay and
publishes a manifest with the SHA-256 of every asset.

As `prebuild`, the engine is **required**, and any failure fails the
build, when `NEXT_PUBLIC_INSTANT_IMPORT` is `admins` or `all` or
`INSTANT_ENGINE_REQUIRED=1`. Otherwise a missing Python or a failed build
prints a warning and the web build continues without Instant Analysis.
Version drift is always fatal. `INSTANT_ENGINE_VERSION` in
`lib/instant/engineVersion.ts` must equal `apps/replay-engine/VERSION`, and
`PYODIDE_VERSION` must equal the exact `pyodide` pin in `package.json`.

`next.config.mjs` serves `/pyodide/**` and `/engine/<version>/<bundle>/**`
with `Cache-Control: public, max-age=31536000, immutable`, and
`/engine/current.json` with `no-cache`.

### Flags

| Variable | Values | Effect |
| --- | --- | --- |
| `NEXT_PUBLIC_INSTANT_IMPORT` | `off` (default) / `admins` / `all`, lowercase | Who sees `/try` and the browser importer. Build-time inlined: redeploy after changing it. `admins` = signed-in accounts with `isAdmin`. The prebuild only treats lowercase `admins`/`all` as making the engine required. |
| `INSTANT_ENGINE_REQUIRED` | `1` | Makes the prebuild engine build mandatory even with the flag `off` (CI sets it). |
| `PYTHON` | path or command | Python used for the wheel venv when `python3` is not the right one. |

The prebuild script reads these from the process environment (the Vercel
project env or your shell), not from `.env.local`. Next.js still inlines
`NEXT_PUBLIC_INSTANT_IMPORT` from `.env.local` into the pages, so locally run
`npm run engine:build` once when you turn the flag on.

The API side needs no flag. `BROWSER_INGEST_DAILY_CAP` (API env) caps
browser uploads per user per UTC day.

### Tests

```bash
npx vitest run lib/instant components/instant   # unit tests (mocked worker, fake-indexeddb)

# Pyodide vs CPython parity (slow): build the engine, generate goldens, compare
npm run engine:build
python ../agent/tests/instant_golden.py --out /tmp/instant-golden
INSTANT_GOLDEN_DIR=/tmp/instant-golden npm run test:engine
```

`npm run test:engine` (`node --test tests/engine/*.test.mjs`) verifies every
built asset against its manifest, boots the bundle in Node with the worker's
real Python glue and, with `INSTANT_GOLDEN_DIR` set, requires envelopes
identical to the CPython goldens. `instant_golden.py` needs a Python with
`sc2reader==1.8.0` installed. Without `INSTANT_GOLDEN_DIR`, only the asset
and smoke checks run.

## Voice readout

The OBS overlay can read the scouting report aloud through the browser's
Web Speech API. The TTS layer lives at
`components/overlay/useVoiceReadout.ts` and is wired into:

- the all-in-one overlay (`/overlay/<token>`), and
- the per-widget URL `?w=scouting` for streamers who want one Browser
  Source per widget.

Other per-widget URLs deliberately do not speak — a stream that runs
both `?w=scouting` and `?w=cheese` should only hear one readout, not
two.

### How to enable it

1. **Settings → Voice**: turn on "Enable voice readout". Pick a voice,
   adjust rate / pitch / volume / pre-utterance delay, and toggle
   per-event lines (scouting is on by default; matchStart, matchEnd,
   and cheese are off). Click **Test voice** to hear the current
   settings — same phrasing the overlay will use.
2. **Open the overlay URL** in OBS or a normal browser tab.
3. **Click anywhere** the first time — browsers (Chrome/Edge/Safari)
   require a user gesture before speech is allowed. The overlay shows
   a small banner bottom-right; clicking it dismisses the banner and
   unlocks speech for the rest of the tab session
   (cached via `sessionStorage`).
4. The next scouting `overlay:live` payload (opponent revealed,
   no `result` yet) will speak exactly one readout.

### Which voices are offered, and why some are hidden

Settings only lists voices that will also exist inside the OBS or
Streamlabs Browser Source. That excludes every "Google …" voice and
Microsoft's "… Online (Natural)" set: those are synthesised on the
vendor's servers and only the vendor's own browser holds the key, so a
Browser Source — which is plain embedded Chromium (CEF) — can never load
them. Offering them produced the long-standing complaint that *"I picked
a female Google voice but the overlay speaks with a Microsoft male
voice"*: the pick vanished at runtime and the old fallback took whatever
the engine flagged as `default`, which on Windows is Microsoft David.

The classifier, the gender table, and the fallback ladder all live in
`lib/voiceCatalog.ts` and are shared by every surface that speaks — the
scouting readout, the Ghost Coach, the Stream Dock's read-aloud, and
multichat chat TTS. When a voice genuinely has to be substituted, the
ladder is:

1. exact name match;
2. name match ignoring case / whitespace drift between engines;
3. **same language *and* same gender** — this is the rung that keeps a
   female pick female;
4. same language, any gender;
5. engine default (only when even the language is unmatched).

The picked voice's `lang` and `gender` are persisted alongside its name
(`voiceLang`, `voiceGender` in `preferences.voice`) so step 3 works even
when the runtime has never seen the original voice. Preferences saved
before those fields existed still work — both are inferred from the
voice name.

Settings shows what will really happen: the note under the picker names
the voice a Browser Source would use, **Hear the OBS version** speaks the
sample line through that voice, and a checkbox re-admits the hidden
browser-only voices for streamers who drive the overlay from a real
Chrome window rather than a Browser Source.

### Verifying with the Test button

`Settings → Voice → Test voice` speaks the same shape the overlay uses
("Facing TestUser, Protoss. You're 3 and 1 against them. Best answer
is 3 Stargate Phoenix, 62 percent win rate."). It picks up your chosen
voice, rate, pitch, volume, and delay every time you press it.

### Troubleshooting

- **No voices listed** in the Settings dropdown — Chrome loads voices
  asynchronously. The component listens for `voiceschanged` and
  re-renders, so wait a second or refresh the page.
- **OBS Browser Source plays nothing** — make sure the source has
  *Control audio via OBS* checked (otherwise audio is muted) and that
  you've clicked the gesture banner once. A scene swap that recreates
  the Browser Source clears the unlock; click again.
- **`not-allowed` errors in DevTools** — the browser revoked the
  unlock. The hook automatically re-shows the gesture banner on the
  next payload.
- **Tab backgrounded for >15 s and the readout cuts out** — Chromium
  pauses synth in hidden tabs. The hook calls `synth.resume()` on a
  timer and on `visibilitychange` to mitigate this; if it still cuts
  out, the readout text is too long. Shorten the bestAnswer build
  name.
- **OS has no TTS engine installed** — `speechSynthesis.getVoices()`
  returns `[]`. Install voices via your OS (Windows: Settings → Time &
  Language → Speech; macOS: System Settings → Accessibility → Spoken
  Content; Linux: `speech-dispatcher` + `festival`/`espeak`).

### Diagnostics

Append `?voiceDebug=1` to any overlay URL (or set `debug: true` on the
persisted voice prefs) to log every step to the DevTools console under
`[VoiceReadout]`: payload received, gate state, chosen voice, sanitised
utterance text, queue depth, cancel/resume events.

### Schema parity

The legacy SPA's `data/config.schema.json#/properties/voice` is the
source of truth for the voice config shape. The web app's prefs mostly
match; differences are documented at the top of `useVoiceReadout.ts`
and `SettingsVoice.tsx`:

| Schema (`config.voice`) | Web (`preferences.voice`) |
| ----------------------- | ------------------------- |
| `enabled`               | `enabled`                 |
| `volume`                | `volume`                  |
| `rate`                  | `rate`                    |
| `pitch`                 | `pitch`                   |
| `delay_ms`              | `delayMs`                 |
| `preferred_voice`       | `voice`                   |
| —                       | `events.{scouting,matchStart,matchEnd,cheese}` |

## Deploy

Push to GitHub. In Vercel: New Project → import this repo → set root
directory to `apps/web` → fill the env vars from `.env.example`.
Production target = `https://<your-domain>`. Add the same domain to
Clerk's allowed origins. See
[`docs/cloud/SETUP_CLOUD.md`](../../docs/cloud/SETUP_CLOUD.md).
