# ADR 0090 · Discord build guide command

The guild-installed Discord application offers one `/build` chat-input
command with nine fixed matchups. Each reply is visible only to its
invoker and uses aggregate stats from the public 12-worker build guides.
SC2 Tools account linking is unnecessary.

## Request and data boundary

- `POST /v1/discord/interactions` has a dedicated IP rate limit, a 16 KiB
  raw JSON limit and a two-second body deadline. The app verifies Ed25519
  over Discord's timestamp and original bytes, with five minutes of
  clock skew, before decoding JSON. Discord's authenticated PING gets
  JSON PONG.
- The API warms a nine-matchup cache from the latest completed aggregate
  generation. It refreshes every ten minutes and invalidates on local
  guide revalidation, including after a recompute. A failed scheduled
  refresh can keep the previous public snapshot for up to twenty minutes
  from its last successful read. Disabled guides,
  empty, expired or warming caches return a guide link without stats.
- Replies include up to five ranked, published rows with public page
  floors, at least five distinct ladder users, canonical guide links
  and aggregate win rates, intervals and game counts. Commands use
  in-memory data only. The route never uses player, channel or server
  identity, stores interaction data, sends follow-ups or calls Discord.
  Access logs and Sentry skip the route.

## Owner setup

1. Create or designate the Discord application and enable **Guild Install**
   in the Developer Portal. Use the `applications.commands` scope. Leave
   the `bot` scope and Discord channel permissions out of the install.
   Set its Privacy Policy URL to
   `https://sc2tools.com/legal/privacy#discord-build-command` and its
   support URL to `https://sc2tools.com/help/discord-build-command`.
2. Configure the API with that application's public
   `DISCORD_APPLICATION_ID` and `DISCORD_INTERACTIONS_PUBLIC_KEY`.
   Set Discord's **Interactions Endpoint URL** to the deployed API origin
   plus `/v1/discord/interactions`. Discord checks a signed PING and an
   invalid signature when validating the endpoint.
3. Preview the registration from the repository root with
   `node apps/api/scripts/register-discord-build.js`. The script reads
   `DISCORD_APPLICATION_ID`; `--guild GUILD_ID` previews a staging server
   registration. For the explicit `--apply` step, supply a short-lived
   OAuth client-credentials access token in
   `DISCORD_COMMANDS_ACCESS_TOKEN`, scoped to
   `applications.commands.update` and issued for the same app. The script
   sends one POST upsert for `/build`; it never replaces a command list.
   Keep the OAuth token and client secret out of API and web deployment
   configuration.
4. Try PING, `/build`, and the private reply in a staging server. Apply
   global registration when ready. After verifying the guild install
   and the command on the deployed API, set
   `NEXT_PUBLIC_DISCORD_BUILD_INSTALL_APPLICATION_ID` to that application
   ID for the web build. This publishes the install link at
   `/help/discord-build-command`. Until then the page offers website guides.

Discord documentation covers [interactions](https://docs.discord.com/developers/interactions/overview),
[response and signature validation](https://docs.discord.com/developers/interactions/receiving-and-responding),
[command registration](https://docs.discord.com/developers/interactions/application-commands),
[OAuth scopes](https://docs.discord.com/developers/topics/oauth2),
the [Developer Policy](https://support-dev.discord.com/hc/en-us/articles/8563934450327-Discord-Developer-Policy)
and the [Developer Terms](https://support-dev.discord.com/hc/en-us/articles/8562894815383-Discord-Developer-Terms-of-Service).
