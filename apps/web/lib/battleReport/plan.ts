import type { ReportBeat, ReportFact, ReportTone, StoryFacts } from "./facts";
import { lintTemplate, phrasebank, type ReportTemplate } from "./phrasebank";

export type ReportSentence = { templateId: string; factId: string; text: string; time: number; timestamps: number[] };
export type ReportParagraph = { id: string; sentences: ReportSentence[] };
export type BattleReport = { headline: string; tone: ReportTone; paragraphs: ReportParagraph[]; facts: StoryFacts };

export function seededHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) { hash ^= value.charCodeAt(index); hash = Math.imul(hash, 0x01000193); }
  return hash >>> 0;
}

export function renderFact(template: ReportTemplate, fact: ReportFact | undefined): ReportSentence {
  if (lintTemplate(template).length || !fact) throw new Error("A report template cannot be filled by the available facts");
  const content = template.pattern.replace("{fact}", () => fact.text);
  return { templateId: template.id, factId: fact.id, time: fact.time, timestamps: fact.timestamps, text: /[.!?]$/.test(content) ? content : `${content}.` };
}

const HEADLINES = ["A report from", "The replay at", "Field notes from", "The account of", "A dispatch from", "The record at", "The battle ledger from", "A match on", "The field account from", "The replay ledger of", "The match record from", "An account from"];

/** Selects observations, not causes. Every claim comes from a named fact. */
export function planBattleReport(facts: StoryFacts, tone: ReportTone = "battle"): BattleReport {
  const usedTemplates = new Set<string>(), usedFacts = new Set<string>();
  const pick = (beat: ReportBeat, ids: readonly string[]) => ids.filter(id => facts.entries[id] && !usedFacts.has(id)).map(id => {
    const bank = phrasebank(tone, beat);
    const offset = seededHash(`${facts.gameId}:${tone}:${id}`) % bank.length;
    // Find through a rotated bank so nearby facts never repeat an introduction.
    const selected = Array.from({ length: bank.length }, (_, index) => bank[(offset + index) % bank.length]).find(row => !usedTemplates.has(row.id));
    if (!selected) throw new Error("Report exhausted its unique template bank");
    usedTemplates.add(selected.id); usedFacts.add(id);
    return renderFact(selected, facts.entries[id]);
  });
  const setting = pick("setting", ["setting", facts.entries.plan ? "plan" : "opener", "opponent-opener", "mmr"]);
  const opening = pick("opening", ["natural", "tech", "first-clash", "gas", "upgrade", "first-attack"].filter(id => facts.entries[id]).slice(0, 3));
  const turning = pick("turning", ["largest-swing", "comeback", "largest-fight", "townhall-exchange"].filter(id => facts.entries[id]).slice(0, 3));
  const aftermath = pick("aftermath", ["result", "workers", "lesson", "early-blocks", "own-structures", "opp-structures"].filter(id => facts.entries[id]).slice(0, 4));
  const eventful = facts.story.fights.length + facts.story.turningPoints.length;
  let groups: ReportSentence[][];
  if (facts.shape === "short" || opening.length + turning.length + aftermath.length <= 2) groups = [[...setting.slice(0, 3), ...(opening.find(row => row.factId === "first-clash") ? [opening.find(row => row.factId === "first-clash")!] : opening.slice(0, 1)), ...turning.slice(0, 1), ...aftermath.slice(0, 3)]];
  else if ((facts.length ?? 0) <= 600) groups = [[...setting, ...opening], [...turning, ...aftermath]];
  else if (eventful >= 3 && opening.length && turning.length) groups = [setting, opening, turning, aftermath];
  else groups = [setting, [...opening, ...turning], aftermath];
  groups = groups.filter(group => group.length);
  const prefix = HEADLINES[seededHash(`${facts.gameId}:headline`) % HEADLINES.length];
  const headline = `${prefix} ${facts.map ?? "the replay"}${facts.shape === "comeback" ? ": a measured reversal" : facts.shape === "swings" ? ": a changing balance" : ""}`;
  return { headline, tone, paragraphs: groups.map((sentences, index) => ({ id: `paragraph:${index}`, sentences })), facts };
}

export function reportText(report: BattleReport, markdown = false): string {
  const heading = markdown ? `# ${report.headline}` : report.headline;
  const date = [report.facts.map, report.facts.date, report.facts.length === null ? null : `${Math.floor(report.facts.length / 60)}:${String(Math.floor(report.facts.length % 60)).padStart(2, "0")}`].filter(Boolean).join(" · ");
  const paragraphs = report.paragraphs.map(paragraph => paragraph.sentences.map(sentence => {
    const clock = `${Math.floor(sentence.time / 60)}:${String(Math.floor(sentence.time % 60)).padStart(2, "0")}`;
    return markdown ? `${sentence.text} [${clock}](/app/game/${encodeURIComponent(report.facts.gameId)}?t=${Math.floor(sentence.time)})` : `${sentence.text} [${clock}]`;
  }).join(" "));
  return [heading, date, ...paragraphs, "Written from this replay's recorded data with fixed rules. No AI."].filter(Boolean).join("\n\n");
}
