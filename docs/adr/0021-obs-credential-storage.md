# ADR 0021 — Windows CurrentUser storage for agent credentials

Status: Supersedes the plaintext decision of 2026-08-02; source integration for item 77C
Date: 2026-11-02
Owner: desktop agent

## Decision

The desktop agent protects its device token and saved obs-websocket password
with Windows CurrentUser DPAPI. It keeps immutable encrypted generations in
`credentials-v1` beside `agent.json`. The state document contains versioned
references and independent slot revisions, together with the existing nonsecret
settings and upload history. It contains neither plaintext credential. OAuth
credentials retain their existing secret-store format and API.

The earlier decision stored both secrets in `agent.json` for a GUI-configured
Windows installation. Both now move together. There is no plaintext, keyring,
or obfuscation fallback when native storage or decryption is unavailable.

## Transaction and startup order

Ordinary state loading is read-only. It does not create directories, migrate
legacy fields, select an orphan generation, or replace an unreadable selected
value with a default. Missing, explicitly cleared and unreadable slots are
distinct private statuses.

Normal startup acquires the actual matching `AgentInstanceLock`, then explicitly
migrates legacy state before constructing any API, pairing, streaming, support
or GUI consumer. Migration encrypts and verifies both legacy secrets before
replacing the complete state document last. A failure before publication leaves
the original bytes intact and prevents consumer startup. Failure messages use
fixed text without native exceptions, credential values or paths.

All state writers retain the existing reentrant serialization. A credential
change declares KEEP, SET or CLEAR and supplies its captured slot revision.
Device changes also supply the current owner epoch and exact candidate owner
metadata. KEEP preserves the selected reference even if decryption failed;
CLEAR selects null without decrypting the old value. Generation writes are
exclusive, complete, flushed and verified. Pointer replacement checks the exact
previous full document and physical store identity. A definite retry reuses
its prepared ciphertext. An uncertain replacement is reread; an indeterminate
outcome blocks ordinary writes instead of rolling back a potentially committed
choice. No automatic orphan deletion is part of this change.

Only a known commit publishes the candidate to the shared state. API/socket
activation and OBS reconfiguration follow outside state and queue locks. A
later reconnect failure cannot undo or misreport the committed choice. Runtime
owner epochs and retained authenticated clients retire monotonically, including
when a revoked device token could not be durably cleared. In that case the
current run stops using it, while a restart is not promised to be unlinked.

## OBS settings and environment precedence

The saved password never prefills a widget. An untouched field means KEEP;
typing a replacement means SET; “Remove saved password” means CLEAR. Dirty
forms retain their captured OBS revision and reject a stale save. The OBS slot
belongs to this installation, so a cloud relink does not rewrite it.

`SC2TOOLS_OBS_PASSWORD` remains an effective runtime override. It is never
migrated or saved, and an explicit saved CLEAR does not remove that environment
override. An unreadable saved slot without an override cannot silently connect
without authentication. A known cleared or first-run missing slot can use an
explicitly configured unauthenticated local OBS server.

Test connection uses a disposable candidate client. It does not save settings
or reconfigure the shared client. Its original revision is checked around OBS
operations and at queued GUI delivery. Scene-build confirmation also retains
the captured account epoch, so a modal dialog cannot approve a newer account.

## Backup, recovery and downgrade

A consistent backup requires `agent.json` and its selected files under
`credentials-v1` together, after the agent has stopped. Copying a state document
alone loses its encrypted values; copying an encrypted file alone does not
select it. DPAPI recovery requires the same Windows user protection context;
these files are not a portable credential export. Nonsecret replay files and
upload history keep their existing format.

If a selected OBS password cannot be decrypted, re-enter it or explicitly remove
it in Settings. Device recovery uses Link again. Unreadable references remain
preserved until an explicit current transaction replaces or clears them.

An older binary cannot use the new encrypted selection. It may treat the app as
unpaired and write plaintext on a new pairing, or replace newer state metadata.
Do not run it concurrently. Stop the agent and retain a complete matching backup
before a deliberate downgrade; relinking alone does not make an old binary
understand the encrypted format. Signed native packaging, installed upgrade and
downgrade acceptance remain separate owner-run release checks.
