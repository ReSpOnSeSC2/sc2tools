# Private local Bot Lab

This integration is hidden by default. It adds no public navigation link and
never runs SC2, models or training on the web/API hosts.

## Enable private access

Set `BOT_LAB_ENABLED=true` separately on the web and API deployments and put the
same authorized Clerk account IDs in `SC2TOOLS_ADMIN_USER_IDS`. With either
gate off, its corresponding surface returns 404. Device tokens cannot access
the control endpoints. The server selects only authenticated device sockets
belonging to the signed-in administrator.

Keep both deployment flags absent for the initial release. The hidden page is
`/bot-lab`. No public access is implied by knowing that path.

## Prepare the computer

Install SC2, pair the desktop agent, and prepare the optional
`apps/bot-runtime` Python environment and local model/map workspace. The agent
itself does not install Torch/JAX, download checkpoints or train at startup.
Create `bot-lab.json` in the agent's state directory with explicit local
configuration:

```json
{
  "enabled": true,
  "python": "C:/SC2Bots/.venv/Scripts/python.exe",
  "workspace": "C:/SC2Bots/workspace"
}
```

Use your actual existing interpreter and workspace paths. The local workspace
contains its own `TRAINING_ACTIVE.json`, committed league snapshots and map
catalogue. The browser cannot supply paths, executables, shell commands or
unverified model URLs. Catalogued choices are hash-checked again when launched.

Finish or pause automatic replay capture through the agent before starting a
bot session. A local engine guard prevents capture and bot launches from
competing for SC2. Existing STOP markers remain authoritative. Bot launch does
not resume league training or remove markers.

## Session recovery

The browser creates one 32-character request ID, persists it with the selected
device and start choices, and uses it for all status, stop and retry requests.
The agent durably reserves that ID before launching a deterministic session.
An ambiguous timeout is recovered on the same computer; the API never retries
on another agent. After a crash, unresolved reservations require reconciliation
instead of silently spawning a second game.

The selected paired-device ID survives socket reconnects. Revoking that device
and pairing it again creates a new identity. Status polls run only while the
private page is open and a session needs attention. Closing the page does not
forfeit a human match; use its Stop control or close SC2 locally.

## Data, performance and release

Models, private replay data, maps, credentials, local paths and process details
are not returned by the bot endpoints. They remain on the paired computer.
Cloud calls are small, bounded control messages with per-device serialization.
The optional UI loads only after the administrator gate succeeds.

Long recorded playback is separate: hash-verified immutable segments live in
R2; ordinary game analytics retain a small pointer. The viewer loads only its
current playback segment and uses a bounded cache. Spectator recordings are
not valid actor observations for imitation learning.

Agent tags build draft GitHub releases with installer/checksum assets. After
CI, artifact verification and active local capture/session checks, a maintainer
publishes the draft. This prevents a tag from interrupting a long capture batch
through automatic updates. For 0.17.0, leave the release staged until the active
mapping queue is safely drained or a verified between-job migration is ready.

Public bot availability, installer runtime provisioning and validated model
distribution require a later rollout. The present integration connects the
existing local development workspace; it does not promise a competitive bot
or an AlphaStar champion model to fresh public installs.
