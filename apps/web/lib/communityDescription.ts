/** Short first paragraph for the header; the full text remains available below. */
export function communityDescription(text: string | undefined) {
  const full = text?.trim() ?? "";
  const first = full.split(/\n\s*\n/)[0].replace(/\s+/g, " ");
  if (first.length <= 160) return { summary: first, showAbout: full !== first };
  const prefix = first.slice(0, 160);
  const boundary = prefix.lastIndexOf(" ");
  return { summary: `${prefix.slice(0, boundary > 0 ? boundary : 160).trimEnd()}…`, showAbout: true };
}
