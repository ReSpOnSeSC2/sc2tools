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

PR B separately implements Community cache tags/revalidation and API headers.
No production secret, integration, data, release, version or infrastructure
change is performed by PR A.
