import { BUILD_TOKENS, type BuildToken } from "./buildTokens";
import { normalizeBuildName } from "./build-events";
import { REFERENCE_ORDER_LIMITS, type ReferenceBuildOrder, type ReferenceBuildStep } from "./buildOrderReference";

export interface BuildOrderPasteIssue { line: number; kind: "error" | "warning"; message: string; excerpt: string }
export interface BuildOrderPasteResult { order: ReferenceBuildOrder | null; steps: ReferenceBuildStep[]; issues: BuildOrderPasteIssue[] }
export const BUILD_ORDER_PASTE_MAX_CHARS = 64_000;
const key = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");
const tokenMap = new Map(BUILD_TOKENS.map(token => [token.token.toLowerCase(), token]));
const cleanAction = (text: string) => text.trim().replace(/\s+/gu, " ");

/** Canonical tokens stay exact. Friendly names and the icon alias normalizer
 * select an existing catalog token; unknown text remains editable reference. */
export function normalizeReferenceAction(text: string): { action: string; known: boolean; race?: string } {
  const action = cleanAction(text), exact = tokenMap.get(action.toLowerCase());
  if (exact) return { action: exact.token, known: true, race: exact.race };
  const normalized = normalizeBuildName(action), wanted = key(normalized.displayName || action);
  const matches = BUILD_TOKENS.filter(token => [token.label, token.entity].some(name => key(name) === wanted || key(name) === key(action)));
  const rank = (token: BuildToken) => token.token.startsWith("Morph") ? 0 : token.kind === "building" && token.token.startsWith("Build") ? 1
    : token.kind === "upgrade" && token.token.startsWith("Research") ? 1 : token.kind === "unit" && token.token.startsWith("Train") ? 1 : 2;
  const chosen = matches.sort((a, b) => rank(a) - rank(b) || a.token.localeCompare(b.token))[0];
  return chosen ? { action: chosen.token, known: true, race: chosen.race } : { action, known: false };
}

/** Four deterministic paste shapes. No inferred clock for supply-only rows. */
export function parseBuildOrderText(text: string, options: { race?: string } = {}): BuildOrderPasteResult {
  const issues: BuildOrderPasteIssue[] = [], steps: ReferenceBuildStep[] = [];
  if (text.length > BUILD_ORDER_PASTE_MAX_CHARS) return { order: null, steps, issues: [{ line: 0, kind: "error", message: "Paste at most 64,000 characters.", excerpt: "" }] };
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const issue = (line: number, kind: "error" | "warning", message: string, excerpt: string) => issues.push({ line, kind, message, excerpt: excerpt.slice(0, 180) });
  let processed = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim(); if (!line) continue;
    if (++processed > REFERENCE_ORDER_LIMITS.steps) { issue(index + 1, "error", "Use at most 120 nonempty lines. Extra lines were not imported.", line); break; }
    let match: RegExpMatchArray | null, clock: string | null = null, supply: number | null = null, name = "";
    if ((match = line.match(/^\[(\d{1,4}:\d{2})\]\s+(?:(\d+(?:\.\d+)?)\s+)?(.+)$/u))) { clock = match[1]; supply = match[2] ? Number(match[2]) : null; name = match[3]; }
    else if ((match = line.match(/^(\d+(?:\.\d+)?)\s+(\d{1,4}:\d{2})\s+(.+)$/u))) { supply = Number(match[1]); clock = match[2]; name = match[3]; }
    else if ((match = line.match(/^(\d{1,4}:\d{2})\s+(.+)$/u))) { clock = match[1]; name = match[2]; }
    else if ((match = line.match(/^(\d+(?:\.\d+)?)\s*[-–—]\s*(.+)$/u))) { supply = Number(match[1]); name = match[2]; }
    else { issue(index + 1, "error", "Use [m:ss] Action, supply m:ss Action, supply - Action, or m:ss Action.", line); continue; }
    const parts = clock?.split(":").map(Number), t = parts ? parts[0] * 60 + parts[1] : null;
    if (parts && (parts[1] > 59 || t! > REFERENCE_ORDER_LIMITS.seconds)) { issue(index + 1, "error", "Use a valid m:ss clock up to 1,440:00.", line); continue; }
    if (supply !== null && (!Number.isFinite(supply) || supply > REFERENCE_ORDER_LIMITS.supply)) { issue(index + 1, "error", "Supply must be from 0 to 1,000.", line); continue; }
    const normalized = normalizeReferenceAction(name);
    if (!normalized.action || Array.from(normalized.action).length > REFERENCE_ORDER_LIMITS.actionChars || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(normalized.action)) {
      issue(index + 1, "error", "Use a nonempty action of at most 80 characters on one line.", line); continue;
    }
    steps.push({ t, supply, action: normalized.action });
    if (!normalized.known) issue(index + 1, "warning", "Unknown action kept as reference text. You can correct it later.", line);
    else if (options.race && options.race !== "Random" && normalized.race !== options.race) issue(index + 1, "warning", `This action belongs to ${normalized.race}. Check the build's race.`, line);
    if (t === null) issue(index + 1, "warning", "Time not supplied. Add timing before using this step for practice.", line);
  }
  return { order: steps.length && !issues.some(item => item.kind === "error") ? { v: 1, source: "paste", steps } : null, steps, issues };
}
