# StarCraft II map artwork

The `*.webp` files in this directory are UI-sized renditions of StarCraft II
ladder-map thumbnails. The `*.jpg` files are the full top-down layout
renditions the map replayer draws under unit playback (served by
`/v1/map-image?variant=layout`) — verbatim source originals for maps
imported by the sync script, higher-resolution curated renders where we
already had them. StarCraft II and the underlying map artwork are ©
Blizzard Entertainment. SC2 Tools is not affiliated with or endorsed by
Blizzard Entertainment.

The historical season index and source image URLs were collected from the
public [Sc2ReplayStats map archive](https://sc2replaystats.com/account/maps/30690/0/1991244/1v1/AutoMM/67/).
`manifest.json` records the exact source URL, published season membership,
dimensions, byte size, and SHA-256 checksum for every optimized rendition.

## Reproducing the import

From `apps/web` run:

```text
npm run maps:sync              # season pages + 640×360 thumbnails
npm run maps:sync -- --layouts # fill in missing full-layout .jpg files
```

The importer:

- checks `robots.txt` before requesting the archive;
- discovers seasons from the site's published selector (season 36 onward);
- makes only one network request at a time with at least a two-second gap;
- honors `Retry-After`, backs off on `429`/`5xx`, and stops on `403`;
- caches season pages and exact source originals under the repo's ignored
  `tmp/` directory, while refreshing `robots.txt` at least daily;
- deduplicates maps shared by multiple seasons;
- records and excludes archive rows that only expose a generic missing-image
  placeholder;
- never recompresses its own generated WebP outputs; and
- emits consistent 640×360 WebP renditions for the API and a small browser
  lookup manifest for graceful no-image fallbacks.

Do not delete the manifest when updating the image set: the public API uses
its aliases to resolve replay-name variations such as optional `LE`, commas,
hyphens, and curly apostrophes without fuzzy matching.
