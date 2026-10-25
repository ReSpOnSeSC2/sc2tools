# Public SEO metadata, PR A

The metadata foundation adds canonical/absolute-URL/description/date helpers,
coherent public social metadata, public-only build/author cards and Try/Download
images. Sign-in/up remain noindex; private/auth subroutes are excluded from
robots discovery. Legal content is unchanged. Definitions' sitemap content
date reflects the requested seven-minute opening correction.

Independent review found two real image failures: Satori rejected the combined
gradient/color background, and public API/body reads were unbounded. The card
now uses the existing Guide background pattern; a 2.5-second public-read
deadline supplies the short-cached neutral image. Actual PNG and held-body
regressions pass. Rule constraints are explicitly labelled as deadlines, and
unknown totals stay unknown rather than inventing zero counts.

Current foundation proof: 68 affected metadata/profile/card assertions pass;
full web types and strict new-source lint pass. This includes 35 focused
URL/date/projection/deadline/actual PNG checks. Production sitemap metadata,
image tracing, visual inspection and unchanged budgets are verified before
the final PR head is published. Main/dependency integration follows this
preserved foundation commit.

Final integration includes released main `59633bfe` and the frozen shared
request correction `de9f98e9`. The seven final affected suites pass 62 tests
(the earlier wider page/profile run passed 68). Full types, the production
build and every unchanged bundle budget pass: landing 190/215, Today
238.6/240 and Try 233/240 kB. The browser engine remains `25b300818c31d41b`.

The actual production HTTP metadata test verifies every returned sitemap URL
plus representative review/guide/counter/community-build/author pages. It
checks canonical URLs, distinct social titles, matching Twitter titles and
indexable public responses. The ordinary Community outage fixture remains
unchanged; its explicit search fixture supplies the indexable case. A missing
counter fixture and inherited Review Board Twitter title/image were corrected.
All four actual public social-image routes return 1200×630 PNGs. Both HTTP
checks pass. The Community build route's real serverless trace includes all
199 local SC2 PNGs. Five actual synthetic cards were rendered and inspected;
the badges stay in bounds, known rule tokens resolve icons, and long titles
retain their complete visible content. Representative PNGs are committed.

Final remote CI and fresh-main merge-tree checks remain merge gates. The
metadata test also includes dynamic fixtures when a build-time API outage
temporarily leaves only static sitemap rows, preserving production fallback.

PR B separately implements Community cache tags/revalidation and API headers.
No production secret, integration, data, release, version or infrastructure
change is performed by PR A.
