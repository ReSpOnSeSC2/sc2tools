/** Internal destinations only; query text and stored URLs never become commands. */
export function isCommandSearchHref(href: string): boolean {
  return href.startsWith("/") && !href.startsWith("//") && !/[\\\s\p{Cc}]/u.test(href);
}
