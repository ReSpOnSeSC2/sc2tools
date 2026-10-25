import { describe, expect, it } from "vitest";
import { battleReportFacts, type ReportBeat, type ReportTone } from "../facts";
import { planBattleReport, renderFact, reportText } from "../plan";
import { lintTemplate, phrasebank, type FactPattern } from "../phrasebank";
import { reportFixtures } from "./fixtures";

const tones: ReportTone[] = ["battle", "caster", "tactical"];
const beats: ReportBeat[] = ["setting", "opening", "turning", "aftermath"];

describe("deterministic battle reports", () => {
  for (const fixture of reportFixtures) for (const tone of tones) it(`${fixture.game.gameId} / ${tone} has stable fact-backed text`, () => {
    const facts = battleReportFacts(fixture), report = planBattleReport(facts, tone);
    expect(reportText(report)).toMatchSnapshot();
    expect(report.paragraphs.length).toBeGreaterThanOrEqual(1);
    expect(report.paragraphs.length).toBeLessThanOrEqual(4);
    expect(new Set(report.paragraphs.flatMap(row => row.sentences.map(sentence => sentence.templateId))).size).toBe(report.paragraphs.flatMap(row => row.sentences).length);
    for (const paragraph of report.paragraphs) for (const sentence of paragraph.sentences) {
      expect(sentence.text).toContain(facts.entries[sentence.factId].text);
      const beforeFact = sentence.text.replace(facts.entries[sentence.factId].text, "");
      // Every numerical token comes from the named fact, never a template.
      expect(beforeFact).not.toMatch(/\d/);
      expect(sentence.time).toBe(facts.entries[sentence.factId].time);
    }
    expect(planBattleReport(facts, tone)).toEqual(report);
  });

  it("omits unknown end conditions, guessed weapon timings and missing expansion facts", () => {
    const facts = battleReportFacts({ game: { gameId: "minimal", result: "Defeat" } });
    expect(Object.keys(facts.entries)).toEqual(["setting", "result"]);
    expect(reportText(planBattleReport(facts))).not.toMatch(/GG|surrender|buildings lost|first attack|first expansion/i);
    expect(facts.date).toBeNull(); expect(facts.length).toBeNull();
  });

  it("keeps plan/classification distinct and never fabricates a reason for their difference", () => {
    const facts = battleReportFacts(reportFixtures[0]);
    expect(facts.entries.plan.text).toBe("Your checked-in plan was Zerg plan; the replay classifier named Zerg replay opening");
    expect(reportText(planBattleReport(facts))).not.toMatch(/scouting said otherwise|because|caused|decided the game/i);
  });

  it("uses completion time for upgrades and tags every fact with a source and game time", () => {
    const facts = battleReportFacts(reportFixtures[2]);
    expect(facts.entries.upgrade.time).toBe(220);
    expect(facts.entries.upgrade.text).toContain("3:40");
    for (const fact of Object.values(facts.entries)) { expect(fact.source.length).toBeGreaterThan(0); expect(fact.time).toBeGreaterThanOrEqual(0); expect(fact.time).toBeLessThanOrEqual(facts.length!); }
    expect(facts.moments.length).toBeGreaterThanOrEqual(2); expect(facts.moments.length).toBeLessThanOrEqual(4);
    expect(facts.entries["first-clash"].timestamps).toEqual([120, 125]);
  });

  it("omits out-of-range events instead of moving a future completion into this replay", () => {
    const facts = battleReportFacts({ game: { gameId: "future", durationSec: 100 }, buildEvents: [{ time: 50, complete_time: 200, name: "FutureUpgrade", category: "upgrade" }, { time: 300, name: "Nexus", category: "building" }] });
    expect(facts.entries.upgrade).toBeUndefined(); expect(facts.entries.natural).toBeUndefined();
  });

  it("keeps two distinct context frames when the only casualty happens at the end", () => {
    const facts = battleReportFacts({ game: { gameId: "end-only", durationSec: 90 }, breakdown: { ok: true, casualty_events: [{ time: 90, owner: "me", killer: "opp", name: "Marine", category: "units" }] } });
    expect(facts.moments.map(row => row.time)).toEqual([90, 0]);
  });

  it("all phrase banks reject unsupported/missing slots and banned wording", () => {
    for (const tone of tones) for (const beat of beats) {
      const bank = phrasebank(tone, beat);
      expect(bank.length).toBeGreaterThanOrEqual(12);
      for (const template of bank) expect(lintTemplate(template)).toEqual([]);
    }
    expect(lintTemplate({ id: "bad", pattern: "{unknown}" as FactPattern })).not.toEqual([]);
    expect(lintTemplate({ id: "bad", pattern: "{fact} {fact}" })).not.toEqual([]);
    expect(lintTemplate({ id: "bad", pattern: "An idiot: {fact}" })).not.toEqual([]);
    expect(() => renderFact(phrasebank("battle", "setting")[0], undefined)).toThrow(/available facts/);
  });

  it("varies every repeated observation across 200 seeds with no sentence in more than 20% of reports", () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 200; i++) {
      const fixture = reportFixtures[2], facts = battleReportFacts({ ...fixture, game: { ...fixture.game, gameId: `synthetic-${i}` } });
      const report = planBattleReport(facts);
      const sentences = report.paragraphs.flatMap(row => row.sentences);
      expect(new Set(sentences.map(row => row.templateId)).size).toBe(sentences.length);
      for (const sentence of new Set(sentences.map(row => row.text))) counts.set(sentence, (counts.get(sentence) ?? 0) + 1);
    }
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(40);
  });

  it("exports both plain text and Markdown links with encoded owner game IDs", () => {
    const input = reportFixtures[0];
    const report = planBattleReport(battleReportFacts({ ...input, game: { ...input.game, gameId: "a/b?x" } }));
    expect(reportText(report, true)).toContain("/app/game/a%2Fb%3Fx?t=");
    expect(reportText(report)).not.toContain("/app/game/");
    expect(reportText(report, true)).toContain("No AI.");
  });
});
