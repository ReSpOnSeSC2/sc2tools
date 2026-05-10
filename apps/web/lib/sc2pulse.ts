// SC2Pulse identity helpers.
//
// The agent stores two distinct identifiers per opponent:
//   - `toonHandle`        — sc2reader's region-realm-bnid string, e.g.
//                           "1-S2-1-267727". This is the value that
//                           appears in the replay folder name on disk
//                           and is always present.
//   - `pulseCharacterId`  — the canonical SC2Pulse character id (a
//                           plain numeric string, e.g. "994428"). Best
//                           effort: populated when sc2pulse.nephest.com
//                           was reachable and a candidate matched the
//                           toon's bnid at ingest time.
//
// The "Pulse ID" column in the UI surfaces `pulseCharacterId` and links
// to sc2pulse.nephest.com so a user can drill into ranked history,
// MMR curve, etc. The toon handle is the fallback shown when we
// haven't resolved a real Pulse character id yet.

const SC2PULSE_ROOT = "https://sc2pulse.nephest.com/sc2/";

/** Build the SC2Pulse character page URL for a numeric character id. */
export function sc2pulseCharacterUrl(pulseCharacterId: string): string {
  const safe = String(pulseCharacterId).trim();
  return `${SC2PULSE_ROOT}?type=character&id=${encodeURIComponent(safe)}&m=1#player-stats-mmr`;
}

/**
 * What to show in the "Pulse ID" cell. Prefers the resolved sc2pulse
 * character id (numeric, links to nephest); falls back to the toon
 * handle (e.g. "1-S2-1-267727") and finally the storage key when no
 * better id exists. Returns null when nothing is identifiable.
 */
export function pickPulseLabel(opp: {
  pulseCharacterId?: string | null;
  toonHandle?: string | null;
  pulseId?: string | null;
}): { value: string; isPulseCharacterId: boolean } | null {
  const cid = clean(opp.pulseCharacterId);
  if (cid) return { value: cid, isPulseCharacterId: true };
  const toon = clean(opp.toonHandle);
  if (toon) return { value: toon, isPulseCharacterId: false };
  const fallback = clean(opp.pulseId);
  if (fallback) return { value: fallback, isPulseCharacterId: false };
  return null;
}

function clean(v: string | null | undefined): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/**
 * "Barcode" detector — display names composed entirely of zero-width-
 * similar glyphs (`I`, `l`, `1`, `i`, `|`, plus unicode lookalikes
 * commonly used for smurf identity masking on the SC2 ladder).
 *
 * Returns true when the trimmed name is non-empty AND every character
 * matches the barcode glyph set. Returns false for any name containing
 * at least one "real" alphanumeric the human eye distinguishes.
 *
 * Arcade modes that surface opponents by name use this to drop unresolved
 * barcodes from the candidate pool — a quiz comparing four
 * indistinguishable strings is broken UX.
 */
export function isBarcodeName(name: string | null | undefined): boolean {
  if (typeof name !== "string") return false;
  const trimmed = name.trim();
  if (trimmed.length === 0) return false;
  // Allowed glyph set: ASCII I, l, 1, i, | plus full-width / Greek-iota
  // / fullwidth-l lookalikes. The Unicode flag lets us match the
  // codepoints directly. If every codepoint is in the set, it's a barcode.
  // I I  l l  1 1  i i  | |
  // Ⅰ Ⅰ (Roman numeral one)  Ι Ι (Greek capital iota)
  // Ｉ Ｉ (fullwidth capital I)  ｌ ｌ (fullwidth lowercase L)
  // ｉ ｉ (fullwidth lowercase I)  １ １ (fullwidth digit one)
  // ｜ ｜ (fullwidth vertical bar)
  return /^[Il1i|ⅠΙＩｌｉ１｜]+$/u.test(
    trimmed,
  );
}
