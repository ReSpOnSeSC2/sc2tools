/**
 * Browser tab titles. The root layout's `title.template` appends the
 * brand to every page title, so a page sets only its own name
 * ("Settings" → "Settings · SC2 Tools"). Search-tuned titles that carry
 * the brand themselves (build guides, /try, Stream Studio) opt out with
 * `title: { absolute: "… | SC2 Tools" }`.
 *
 * Client components that change what is on screen without a route
 * change (a Settings tab) set the same shape with `useDocumentTitle`.
 */
export const SITE_NAME = "SC2 Tools";

/** Next.js `title.template` for the root layout. */
export const SITE_TITLE_TEMPLATE = `%s · ${SITE_NAME}`;

/**
 * A page title as the template renders it.
 *
 * Example: `siteTitle("Overlay · Settings")` → "Overlay · Settings · SC2 Tools".
 */
export function siteTitle(title: string): string {
  return SITE_TITLE_TEMPLATE.replace("%s", title);
}
