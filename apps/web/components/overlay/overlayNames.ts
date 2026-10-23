/** Return only a close suggestion; never list every overlay ID on stream. */
export function closestOverlayName(name: string, known: readonly string[]): string | null {
  // A path can be arbitrarily long. Bound the dynamic-programming work.
  if (name.length > 80) return null;
  let best: string | null = null;
  let distance = 4;
  for (const candidate of known) {
    let row = Array.from({ length: candidate.length + 1 }, (_, i) => i);
    for (let i = 0; i < name.length; i++) {
      const next = [i + 1];
      for (let j = 0; j < candidate.length; j++) next.push(Math.min(next[j] + 1, row[j + 1] + 1, row[j] + (name[i] === candidate[j] ? 0 : 1)));
      row = next;
    }
    if (row[candidate.length] < distance) { best = candidate; distance = row[candidate.length]; }
  }
  return best;
}
