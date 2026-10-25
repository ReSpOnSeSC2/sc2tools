# ADR 0037: Additive game scenes and locally confirmed website sources

Status: Accepted, 2026-10-25.

The scene builder includes the all-in-one game overlay by default, with three
optional game sources. Fixed reference rectangles scale with the canvas. Existing
authenticated same-route Browser Sources are reused, avoiding another renderer
and voice connection. Explicit Update adds only missing references; it does not
repair, remove, reset or reorder existing items. Narrow switcher compatibility
repairs remain separate. Destructive replacement keeps its explicit guard.

Website Add sends a strict widget identifier to one authenticated device. The
cloud requires Clerk ownership, advertises online device capabilities, bounds
owner/global admission and validates a request/device-bound acknowledgement.
There is no broadcast, database aggregation or retry of an uncertain write.

Native website requests are off by default and unavailable without the GUI or
under `--no-obs`. A default-Cancel local dialog names the current program scene.
After consent, the agent rechecks its authenticated socket's pairing, settings,
expiry and program scene before writing. A shared write lock serializes this
with the builder. Only the agent resolves its default overlay URL; cloud/client
commands cannot supply URLs, credentials, paths, scripts or OBS operations.

The website shares one availability lookup across cards. Account/auth transitions
cancel pending UI work and late token/body completions cannot act under a new
owner. A true deadline covers token lookup, network and response parsing. Copy
and Drag remain available for a particular token/theme/Ghost configuration.
Ghost website Add is disabled and its API command rejected because the private
assigned build fragment cannot travel in the widget-only request. The optional
builder Ghost source warns visibly that it starts unassigned. Website additions
preserve the priority of existing authenticated cover/alert anchors.
New references start disabled, receive their transform/priority, then become
visible after one final account/expiry/program-scene check. Failed setup can
leave a disabled source for inspection; it never flashes above a live cover.

The native reference ticker is a 1920×56 scene strip; website standalone Add uses
the shared recommended size JSON (1920×180). Tests exercise fake clients and
offscreen Qt only. No real OBS integration, installer, release, signing or version
change is required or executed.
