# ADR 0101: Humdingers ships as a static page, not an Arcade mode

Status: Accepted, November 26, 2026. Amended by ADR 0102
(`docs/adr/0102-humdingers-account-saves-and-play-stats.md`): the game now needs
sign-in, and `/play/humdingers` is a host page that keeps saves in the account.

## Context

- Humdingers is the site owner's browser RPG, built outside this repository.
  Its build is one self-contained HTML file (build 7c680ae362fd: 9.8 MB,
  2.9 MB gzipped) with inline scripts, data: URLs and touch controls, and it
  makes no outside requests. The owner wants anyone, signed in or not, to
  play it on a phone or a desktop, featured on the home page and in the
  Arcade.
- The Arcade is a tab under `/app`, which `middleware.ts` keeps behind Clerk
  sign-in. Its 18 modes are a locked catalog of replay-data modes
  (`components/analyzer/arcade/README.md`, `scripts/depthLint.mjs`,
  `lib/productFacts.ts`).
- The site sends no Content-Security-Policy: none in `next.config.mjs`,
  `middleware.ts` or a `vercel.json`. `public/sw.js` precaches only
  `/offline.html` and sends navigations to the network.
- The file mixes CRLF and LF lines. With `core.autocrlf=true`, as on the
  owner's Windows machine, git rewrites the CRLF lines on commit, so the
  served file would no longer be the built one.

## Decision

1. The build is copied unchanged to `apps/web/public/play/humdingers.html`.
   `.gitattributes` marks `apps/web/public/play/*.html` as
   `binary linguist-generated`: exact bytes, no text diff, and no weight in
   the language stats.
2. The file is public because Clerk's matcher skips dotted paths. The clean
   link `/play/humdingers` is rewritten to it in `middleware.ts` before Clerk
   runs, so it needs no session and never waits on a handshake.
3. Every link to the game is a plain `<a>` (`isStaticPlayPath` in
   `lib/humdingers.ts`). Next's `Link` would prefetch the whole file, and a
   click first fetches it as an RSC payload before falling back to a full
   page load.
4. It is featured outside the Arcade catalog: a card right after the landing
   hero and a link above the Arcade tabs. The catalog, depthLint and
   `PRODUCT_FACTS.arcadeModes` stay at 18.
5. Its What's New entry ships without `major`. The website shows the entry
   in the same Vercel deployment as the page, but the API deploys on Render
   separately and would notify users on their next visit, possibly before
   the page is live. A one-line follow-up sets `major` once the page is
   confirmed live in production.

## Consequences

- Updating the game means copying a new build over the file and committing
  it. Each update adds up to the file's compressed size (about 3 MB today)
  to the history. Full clones carry every version; Vercel and CI shallow
  clones carry only the current one. Moving the file to Git LFS or another
  host is the owner's call.
- The game shares the site's origin. It keeps its storage under the
  `humdingers.` prefix and never clears storage, so it does not touch site
  data.
- If a Content-Security-Policy is ever added, `/play/` needs an exception for
  inline scripts and data: URLs.
- `public/sw.js` needs no change for the game: its offline page appears only
  when the network is down, when the game could not load anyway. Changing
  the worker would prompt every installed user to update.
