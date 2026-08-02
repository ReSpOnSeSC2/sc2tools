# ADR 0021 — The obs-websocket password lives in agent.json

Status: Accepted
Date: 2026-08-02
Owner: desktop agent

## Context

Automatic OBS scene switching
([docs/obs-auto-scene-switching.md](../obs-auto-scene-switching.md))
needs the obs-websocket server password. That is a credential, and
[ADR 0013](0013-two-config-files.md) has an explicit rule about
credentials:

> **Is it a credential (token, password)?** -> `.env`. Never JSON.

We are not following that rule here. This ADR records why, so the
divergence is a decision rather than an oversight someone "fixes" later
and breaks setup for every non-technical user.

## The problem with `.env` for this field

ADR 0013 was written about the **legacy** self-hosted product
(`reveal-sc2-opponent-main` + `stream-overlay-backend`). That product
was started from a terminal by a user who already had a `.env` open.

The cloud agent is not that. It is a Windows `.exe` installed by an
NSIS installer, launched from the Start menu, and configured entirely
through a PySide6 Settings tab. Its users are streamers, not
developers. Telling them to locate an install directory, create a
dotfile, and restart the agent — to enable a feature whose entire
selling point is that it removes manual work — is not a real option.

Every credential-shaped field the cloud agent already has is on the
same footing, and the precedent is already set in the opposite
direction: `AgentState.device_token` is a **live bearer token** that
authenticates every upload to the cloud API, and it has been stored in
`%LOCALAPPDATA%\sc2tools\agent.json` since the agent shipped. Putting
`obs_password` anywhere else would be inconsistent without being safer.

## What the password actually protects

Worth being concrete about the blast radius, because it is small:

* It authenticates to a **localhost** (or LAN) service on the user's
  own machine.
* obs-websocket's capability surface is "control OBS": switch scenes,
  start/stop the stream, move sources. Unpleasant, not catastrophic.
* An attacker who can read `agent.json` already has read access to the
  user's `%LOCALAPPDATA%`, which means they already have the device
  token — a *cloud* credential that is strictly more valuable — plus
  every replay on the machine.

There is no threat model in which the OBS password is the weakest link
in that directory.

## Decision

Store `obs_password` in `AgentState`, alongside `device_token`, in
`%LOCALAPPDATA%\sc2tools\agent.json`.

Required mitigations, all implemented:

1. **Sentry redaction.** `crash_reporter._is_pii_key` gained
   `password` / `passwd` / `secret` fragments. The fragment is
   deliberately broad so it catches `obs_password` and anything a
   future subsystem names similarly without needing another entry.
2. **Never logged.** The connection log line carries host and port
   only. `obs_connect_failed ... reason=auth_failed` says a password
   was rejected, never which one.
3. **Env override for anyone who wants it.**
   `SC2TOOLS_OBS_PASSWORD` takes precedence over the state file, so a
   power user (or a shared/kiosk machine) can keep it out of JSON
   entirely.
4. **Masked in the UI.** The Settings field uses
   `QLineEdit.Password` echo mode.

## Alternatives considered

**Windows Credential Manager via `keyring`.** Genuinely more secure at
rest, and the right answer if the credential were more valuable. Costs
a new dependency plus its PyInstaller hidden-imports and backend
plumbing, for a localhost service password sitting in the same
directory as a cloud bearer token. Not proportionate. Revisit if the
agent ever stores something that actually warrants OS-level protection
— at which point `device_token` should move first.

**Obfuscating the value in JSON.** Rejected outright. Reversible
encoding with the key in the same binary is security theatre; it makes
the file harder to support without making it harder to read.

**Not storing it — prompt each launch.** Defeats the point of an agent
that runs minimised from login.

## Consequences

* ADR 0013's "never JSON" rule now has one documented exception, scoped
  to the cloud agent's own state file. It still holds for the legacy
  product's config files, which is what it was written about.
* Anyone adding a *new* credential to the agent should read this ADR
  and the blast-radius argument above, not just copy the precedent. A
  credential that reaches beyond the user's own machine deserves the
  `keyring` conversation.
* If `device_token` ever moves to OS-level storage, `obs_password`
  should move with it — the argument here is explicitly "no worse than
  the token next to it."
