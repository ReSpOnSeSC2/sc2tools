# Public-page metadata checklist

When adding or changing a public, indexable page:

- Give it a self-referencing canonical without tracking/filter parameters.
  Use `lib/seo/pageMetadata.ts` for coherent Open Graph and Twitter fields;
  supply the route's own descriptive share title.
- Resolve JSON-LD links through `lib/seo/absoluteUrl.ts` and serialize with
  the existing JSON-LD helper. User-authored strings remain data.
- Add a sitemap row only for a public page that really exists. Use the date
  its content changed, never the request time. Leave authenticated/token pages
  out, retain noindex on sign-in/sign-up and preserve the robots exclusions.
- Use the fixed en-US/UTC public date helper for SSR dates shared with a client
  component; do not let the server and browser select different time zones.
- Use a route social image when appropriate. Build/author cards read public
  projections only; no private replay links, account IDs or notes. Opening
  rules are deadlines, not recorded build steps. Keep five bounded positive
  rows and local registry icons, with neutral unavailable fallback.
- Run the metadata helper, projection, actual ImageResponse and consumer tests.
  After a production build, run `tests/e2e/public-seo.spec.ts` to check every
  current sitemap route. Inspect actual social PNGs and unchanged JS budgets.

The metadata PR does not enable Community revalidation. Its cache policy and
operator configuration are handled separately in the deployment guide.
