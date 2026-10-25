/** Snippets end at a word boundary when one fits. Clip by Unicode code point
 * so an emoji or supplementary character is never cut into invalid UTF-16. */
export function trimDescription(value: string, maximum = 200): string {
  const text = value.replace(/\s+/g, " ").trim();
  const bound = Number.isSafeInteger(maximum) ? Math.max(1, Math.min(1000, maximum)) : 200;
  const chars = Array.from(text);
  if (chars.length <= bound) return text;
  if (bound === 1) return "…";
  const cut = chars.slice(0, bound - 1).join("");
  const space = cut.lastIndexOf(" ");
  return (space > 0 ? cut.slice(0, space) : cut).trimEnd() + "…";
}
