# One deterministic chat-command registry

Status: accepted, 2026-10-25.

`apps/api/src/services/chatCommands.js` owns the builtin catalog, aliases,
platforms, allowed variables and settings validator. The web catalog is
generated from it. Twitch IRC, the generic Nightbot endpoint and the on-stream
command endpoint call one `ChatCommandService` and the same `ChatbotService`
line composer. Existing viewer-rank, prediction, poll and shout-out actions
retain their specialized paths.

Private `preferences.chatCommands` contains builtin overrides and at most
25 custom plain-text replies. Writes validate names, collisions, platforms,
strict booleans and cooldowns from5 to3600seconds. Canonical builtin names and
their established aliases remain accepted beside an owner alias; disabling a
builtin disables every spelling. Only whitelisted variables are expanded, each
at most once per reply, and every outgoing line is stripped of markup/control
characters and clipped to380characters. The secret-bearing Twitch connection
settings remain in their separate masked namespace.

A bounded4096-entry process cooldown ledger claims synchronously before
composition; capacity refusal keeps live cooldowns intact. Commands share one
canonical cooldown across aliases/platforms, plus a5second per-viewer cooldown.
Chat and on-stream answer lanes are separate so connecting the IRC bot does
not suppress the Browser Source answer to that same message. Existing HTTP
rate guards remain in force. Owner Try uses the saved settings and exact
composer, checks the selected token's owner, bypasses cooldowns, and never
sends or queues a message. Token resolution is checked again after composition.

History commands use one bounded slim read (at most10001rows,1500ms deadline)
per owner snapshot and retain only compact summaries. Requests coalesce;
cache cardinality is128owners with30second freshness and at most32in-flight
owners. Owner revisions prevent late work from repopulating invalidated cache.
Incomplete cohorts withhold misleading rates/peaks and explain the safety
limit. Visibility, permanent-deletion intent, replay-resume, future-date and
team guards precede history calculations. UTC defines the daily record.

Season boundaries are read from the existing in-process catalog without
refreshing it or the map pool. Peaks and season rates use the latest recorded
ladder region, without borrowing a PTR or another region's rating. Missing
cached boundaries are disclosed. H2H uses exact recorded toons or confidently
resolved native profiles; uncertain display-name matches cannot identify a
player. Counter IDs use canonical strings; bounded game lookups also accept
the same safe numeric ID in legacy rows. Last-three reads and cached totals
have separate deadlines. Prediction leaders reuse the existing top-three
service and uptime reads the already-saved stream-session anchor.

No AI/model call, new infrastructure, collection, index, background job,
environment variable, provider integration or production action is introduced.

Nightbot snippet syntax follows its official
[QueryString](https://docs.nightbot.tv/variables/querystring) and
[UrlFetch](https://docs.nightbot.tv/variables/urlfetch) documentation; arguments
and viewer names are URL-encoded, and the380-character line fits its plain-text
response limit. This is copied configuration, never an automatic provider write.

## Optional reply links

`!build` can append its published guide, using the canonical catalog slug and
the guide page's publication floor. `!sc2tools` is disabled by default. An
existing custom command or alias of that name has priority over the canonical spelling.

The per-command `includeLink` setting defaults to false. The composer reserves
room for the entire URL within the 380-character limit and appends it only in
chat. Linked replies share a two-minute cooldown in the existing ledger. The
owner preview uses the same saved settings and bypasses the cooldown.

## Answer as me

An authenticated owner opens live replies in Chat command settings and chooses
one live viewer command. Twitch and Kick chat arrive through browser readers.
The YouTube relay also takes browser-supplied continuation values. Those paths
keep their existing on-stream behavior and cannot initiate an OAuth chat write.
The live reply action stays in owner Settings because the OBS Dock has only
the overlay credential.

The owner endpoint resolves the token and composes the saved command inside
the existing token write fence and platform chat grant. It checks the saved
source and connected account again before sending. Twitch and Kick use the
provider's reply-to-message ID and the room carried by the transport. A Twitch
Shared Chat preflight checks that the user grant can send without mirroring
the reply to additional rooms. Kick verifies the saved room ID through the
existing public channel resolver and requires a successful match. YouTube
resolves one exact owned live video, including when multiple broadcasts are
live. Linked replies reserve the complete URL within the platform limit. The shared chat cooldown
and a bounded source-message receipt cover duplicate clicks and uncertain
delivery. A configured Twitch bot that already answers the channel keeps
that responsibility. The endpoint excludes commands that draw private player
data and uses a neutral viewer label in custom variables.

[Twitch Send Chat Message](https://dev.twitch.tv/docs/api/reference/chat#send-chat-message),
[Twitch Get Shared Chat Session](https://dev.twitch.tv/docs/api/reference/chat#get-shared-chat-session),
[Kick Chat API](https://docs.kick.com/apis/chat).
