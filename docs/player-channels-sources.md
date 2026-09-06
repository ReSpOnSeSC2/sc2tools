# Player channel seed sources

Verified on **2026-09-06**. The snapshot timestamp is stored in each JSON file as `verifiedAt` (UTC). These files contain public upstream facts, not example records. SC2Pulse's roster/link data is attributed to SC2Pulse; curated YouTube channels were checked against their live YouTube page metadata.

## SC2Pulse snapshot

`apps/api/data/player-channel-pulse-seeds.json` contains 1,243 players with at least one Twitch or YouTube channel: 1,237 Twitch links and 185 YouTube links. The complete public roster contained 1,637 players when fetched; players without either channel type were omitted. The snapshot was assembled from one roster request and 17 sequential requests of at most 100 player IDs, with a short delay between batches.

- [Public player roster](https://sc2pulse.nephest.com/sc2/api/revealed/players): flat records with stable SC2Pulse `id`, `nickname`, and other player metadata.
- [Example batch of full player records](https://sc2pulse.nephest.com/sc2/api/revealed/player/3,14,17,20,38,183,414,535,517162/full): records contain `proPlayer`, `proTeam`, and `links`. Only `TWITCH` and `YOUTUBE` URLs were copied into the seed snapshot; each entry includes its individual upstream source URL.
- [Upstream controller](https://github.com/sc2-pulse/sc2-pulse/blob/master/src/main/java/com/nephest/battlenet/sc2/web/controller/RevealedController.java): documents the existing public roster and batch endpoints used for this import.

The snapshot preserves SC2Pulse's player associations. Channel URLs use HTTPS and omit query strings, fragments, and known YouTube channel tabs (`/featured` and `/streams`). All 1,449 channel values across both seed files passed the application's channel URL validator; all 152 curated character/toon mappings passed its identity validator. The combined seed files represent 1,245 distinct players. This validation does not independently certify ownership or current availability of every imported channel. Links can change; use the admin import to refresh upstream data and the admin editor to correct/remove associations. No upstream player names are used as runtime identity keys.

## Curated channel additions

`apps/api/data/player-channel-seeds.json` adds/canonicalizes fourteen creators' channels. Every YouTube channel returned HTTP 200 with the expected channel title and canonical channel ID in YouTube's public page metadata. The Twitch URLs came from SC2Pulse's full player records, except Cubano's verified official Twitch page. Twelve entries use exact character IDs and toon handles from the public [character endpoint](https://sc2pulse.nephest.com/sc2/api/characters?proPlayerId=414) using the stable `proPlayerId`. Calyx and Cubano use the account and exact replay identity verification documented below; no nickname search result was attached automatically.

| Creator | SC2Pulse player ID | YouTube channel | Exact character mappings |
| --- | --- | --- | ---: |
| Hupsaiya | 414 | [Hupsaiya](https://www.youtube.com/channel/UCSASDKRSbOWvYZSkaoRTAiQ) | 11 |
| MaNa | 14 | [MaNa Esports](https://www.youtube.com/channel/UCpYa4jhRPdIS5QqsEedKxsQ) | 11 |
| Harstem | 17 | [Harstem](https://www.youtube.com/channel/UCCRdB9rqzP2m7bPYb5drH_Q) | 7 |
| PiG | 183 | [PiG](https://www.youtube.com/channel/UC9OluGthYmZo0vsF9IjicFg) | 7 |
| uThermal | 38 | [uThermal](https://www.youtube.com/channel/UC--TKxqP8xJNymgrLe-thhA) | 20 |
| Lambo | 20 | [LamboSC2](https://www.youtube.com/channel/UCo9wnFnX8sK0eYdX_16HKSw) | 6 |
| Lowko | 535 | [LowkoTV](https://www.youtube.com/channel/UCZNTsLA6t6bRoj-5QRmqt_w) | 4 |
| HeroMarine | 3 | [HeroMarine](https://www.youtube.com/channel/UC7rv1GiWm9RCFK503h2nVaQ) | 29 |
| Winter | 517162 | [WinterStarcraft](https://www.youtube.com/channel/UCk3w4CQ_SlLH4V0-V6WjFZg) | 34 |
| BerryCruncH | 488 | [BerryCrunch](https://www.youtube.com/channel/UCgYV3u-T9I_1iYXG4K-JiHA) | 11 |
| Heaven | 517339 | [heaven / @heavenstarcraft](https://www.youtube.com/channel/UCkWW-NsS78I39fHgdqwi_1w) | 4 |
| Calyx | No pro record | [Calyx / @CalyxLeMaster](https://www.youtube.com/channel/UC6zSZ9cnTrN4vN4oWTGnnYA) | 3 |
| ReSpOnSe | 361 | [ReSpOnSeSC2](https://www.youtube.com/channel/UCZS3YP1mvpqyuU5vPvHVG7g) | 3 |
| Cubano | No pro record | [CuBaNo Sc2](https://www.youtube.com/channel/UCvm30CZsbWyFt8CaXBiZvUA) | 2 |

Hupsaiya, ReSpOnSe, and Winter's caster record did not have YouTube in the upstream snapshot; those links are additions. Calyx and Cubano are new player entries; other curated entries convert upstream aliases to the verified canonical YouTube channel ID URL. PiG's [own website](https://www.pigstarcraft.com/) also links his main channel. MaNa's live channel biography identifies him as Grzegorz Komincz, matching SC2Pulse. The user's text “man's” was interpreted as MaNa in this SC2 creator context. Winter's caster record is **517162** (Evan Ballnik), distinct from Swedish player Winter, record 181.

BerryCruncH's [SC2Pulse record](https://sc2pulse.nephest.com/sc2/api/revealed/player/488/full) and YouTube metadata both link `twitch.tv/berry_crunch`. His [eleven exact characters](https://sc2pulse.nephest.com/sc2/api/characters?proPlayerId=488) include Pulse `108882` / toon `1-S2-1-1010182` and Pulse `108485` / toon `1-S2-1-8205455`, both verified in the user's live opponent history. Heaven's [SC2Pulse record](https://sc2pulse.nephest.com/sc2/api/revealed/player/517339/full) and YouTube biography both link `twitch.tv/heavensc`. His [four exact characters](https://sc2pulse.nephest.com/sc2/api/characters?proPlayerId=517339) belong to the account `Heaven#13998`. His [live opponent profile](https://sc2tools.com/app/opponents/1-S2-1-596714) confirmed Pulse `21864`, toon `1-S2-1-596714`, and the same pro identity and Twitch channel. These are separate creator entries with their own verified identities and channels.

ReSpOnSe's own signed-in Settings → Overlay → Multi-platform chat fields identify `responsesc2` on Twitch and `@ReSpOnSeSC2` on YouTube. YouTube's public metadata resolves that handle to the canonical channel ID `UCZS3YP1mvpqyuU5vPvHVG7g`; a [published stream](https://www.youtube.com/watch?v=t0UVWSxFUoA) also links `streamlabs.com/responsesc2`. His [SC2Pulse pro record](https://sc2pulse.nephest.com/sc2/api/revealed/player/361/full) supplies the same Twitch channel, and the [three exact character records](https://sc2pulse.nephest.com/sc2/api/characters?proPlayerId=361) map US `994428` / `1-S2-1-267727`, EU `8970877` / `2-S2-1-8780508`, and KR `9034461` / `3-S2-1-6833017` to `ReSpOnSe#1872`. The US toon matches the user's replay identity. Only the public channel field values were used from settings.

## Calyx: user-identified account and exact identity verification

The requested Terran creator's live channel is [Calyx / @CalyxLeMaster](https://www.youtube.com/channel/UC6zSZ9cnTrN4vN4oWTGnnYA). The channel identifies itself as SC2 instruction, and its [Terran build video](https://www.youtube.com/watch?v=NLqBlueQ0bY) is linked from the [Calyx build order on Spawning Tool](https://lotv.spawningtool.com/build/199709/).

There was no Calyx player in the public SC2Pulse pro roster. The user identified the requested creator as the Calyx in their player list. Opening that exact [live opponent profile](https://sc2tools.com/app/opponents/1-S2-1-12581432#h2h=timeline) confirmed Pulse character `340944865` and toon `1-S2-1-12581432`, matching the saved replay identity. The linked EU and KR characters belong to the same account, `Calyx#11593`; their [public exact-character records](https://sc2pulse.nephest.com/sc2/api/group/character/full?characterId=340944865,341105584,341284585) provide these identities:

| Region | SC2Pulse character ID | Toon handle |
| --- | --- | --- |
| US | 340944865 | 1-S2-1-12581432 |
| EU | 341105584 | 2-S2-1-10537315 |
| KR | 341284585 | 3-S2-1-8496074 |

The curated entry now connects the verified YouTube URL to these three exact identities with `proId: null`. The channel-to-account association relies on the user's identification, corroborated by the live player list and saved replay identity; it does not claim independent channel ownership verification by SC2Pulse. Another unrelated `Calyx#1337` appears in search and is excluded. The creator's linked [example replay](https://drop.sc/replay/26705213) is a reviewed game of other players and was not used as identity evidence. Admins can edit or remove this association through the shared directory UI.

## Cubano: registered account and public match verification

The user identified Cubano as a registered SC2 Tools player. His public [Twitch About page](https://www.twitch.tv/cubanosc2/about) identifies an SC2 creator and explicitly links the [CuBaNo Sc2 YouTube channel](https://www.youtube.com/channel/UCvm30CZsbWyFt8CaXBiZvUA). YouTube's public metadata confirms that canonical channel ID and the handle `@CuBaNoSc2`.

The registered account's win against LockStock on Blackrock LE on July 25, 2026 at `21:38:14Z` matches a [public Pulse match](https://sc2pulse.nephest.com/sc2/api/character-matches?toonHandle=1-S2-1-8085636&type=_1V1&limit=100&after=eyJ2IjoxLCJhIjpbIjIwMjYtMDgtMDJUMjM6MjM6MzVaIiwxLDU1MzcyLDFdfQ) at `21:38:12Z`: the same map, outcome, and opponent, Pulse `109044` / toon `1-S2-1-2258847`. This corroborates Cubano's exact US identity, Pulse `257695962` / toon `1-S2-1-8085636`. Match duration was not used as corroboration because the sources report different durations. The [public account roster](https://sc2pulse.nephest.com/sc2/api/characters?accountId=257696061) links the US and EU characters to `IMCuBaNo#1119`:

| Region | SC2Pulse character ID | Toon handle |
| --- | --- | --- |
| US | 257695962 | 1-S2-1-8085636 |
| EU | 341338524 | 2-S2-1-11106114 |

Cubano has no SC2Pulse pro record, so his entry uses `proId: null` and these exact identities. The unrelated Terran player with toon `1-S2-1-8311231` is excluded. No private registered-account identifiers or contact details are included in the seed data or provenance.

## Scope of verification

The curated roster is a bounded starting set, not a claim to have found every SC2 player's YouTube channel. Existing SC2Pulse channel information is included in the full snapshot; administrators and account owners can extend the shared directory to additional players. Canonical YouTube channel IDs are used for curated entries to avoid mutable handle aliases. Seed data should fill missing entries without restoring channels that a user or administrator has removed or overriding later edits.
