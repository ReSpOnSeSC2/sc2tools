/** Lightweight help URLs; safe for clients that do not need the article registry. */
export function helpArticlePath(slug: string, anchor?: string): string {
  return anchor ? `/help/${slug}#${anchor}` : `/help/${slug}`;
}
