import type { ReportBeat, ReportTone } from "../facts";

export type FactPattern = `${string}{fact}${string}`;
export type ReportTemplate = { id: string; pattern: FactPattern };

// These introductions carry no replay claims. The typed fact slot supplies
// every player, unit, timestamp, number and observation in the sentence.
const prefixes: Record<ReportTone, Record<ReportBeat, readonly string[]>> = {
  battle: {
    setting: ["Dateline: ", "The field report began here: ", "The stage was set: ", "From the opening dispatch: ", "The match record opened: ", "The scene before the fighting: ", "The opening page of the report: ", "From the replay's opening record: ", "The field notes began: ", "The account opened with this: ", "The prelude, as recorded: ", "The first dispatch established this: "],
    opening: ["The early dispatch recorded this: ", "The next entry in the field notes: ", "The opening record showed: ", "From the early movements: ", "The campaign ledger marked this: ", "The first movements left this record: ", "A dispatch from the developing game: ", "The early pages documented this: ", "The opening unfolded in the record: ", "From the first exchanges: ", "The next recorded development: ", "An early entry worth watching: "],
    turning: ["The central dispatch: ", "The largest change in the record: ", "The field ledger singled out this moment: ", "The middle pages carried this account: ", "A change of position, as measured: ", "This passage stood out in the samples: ", "The report's pivotal observation: ", "The changing balance left this record: ", "The campaign notes highlighted this: ", "A moment to revisit: ", "The engagement record noted this: ", "The account's central observation: "],
    aftermath: ["The closing dispatch recorded this: ", "The aftermath, in the record: ", "The final ledger entry: ", "The report closed on this fact: ", "From the closing field notes: ", "At the end of the account: ", "The record left this observation: ", "The post-match ledger noted this: ", "The final page documented this: ", "The closing assessment: ", "For the record after the fighting: ", "The last dispatch carried this: "],
  },
  caster: {
    setting: ["Here was the matchup: ", "The opening card read: ", "This was the stage: ", "The replay set the scene: ", "Here was the starting story: ", "The match introduction: ", "The tale opened here: ", "The players took this stage: ", "The opening record was clear: ", "Before the action, the facts: ", "The match began with this picture: ", "Here was the opening setup: "],
    opening: ["Now follow the clock: ", "Here was the next development: ", "Watch this point in the replay: ", "The opening brought this entry: ", "Here was an early moment: ", "The record picked up this movement: ", "This was worth a look: ", "The next timestamp told us: ", "The opening log caught this: ", "Keep this moment in view: ", "Here was the early-game record: ", "The replay's next note: "],
    turning: ["Here was the big sampled change: ", "Watch the balance here: ", "This was a moment to rewind: ", "The measured picture shifted here: ", "The replay highlighted this passage: ", "This was the central entry: ", "Now look at this observation: ", "The record made this stand out: ", "Here was the marked moment: ", "The samples put a spotlight here: ", "The ledger's headline observation: ", "This was the swing to watch: "],
    aftermath: ["And the record finished here: ", "The final readout: ", "Here was the closing picture: ", "The replay left us with this: ", "The post-game record showed: ", "This was the final entry: ", "After the action, this remained: ", "The closing numbers said: ", "The final page of the replay: ", "Here was the post-match note: ", "The record at the finish: ", "For the closing replay check: "],
  },
  tactical: {
    setting: ["Situation: ", "Match context: ", "Initial record: ", "Replay identification: ", "Opening context: ", "Recorded setup: ", "Participants and theater: ", "Initial observation: ", "Context entry: ", "Match parameters: ", "Opening identification: ", "Baseline record: "],
    opening: ["Chronology: ", "Early observation: ", "Opening sequence: ", "Timing record: ", "Recorded development: ", "Initial progression: ", "Build chronology: ", "Early replay entry: ", "Observed sequence: ", "Opening evidence: ", "Timestamped entry: ", "Sequence note: "],
    turning: ["Lead assessment: ", "Central observation: ", "Measured change: ", "Engagement assessment: ", "Comparative record: ", "Replay finding: ", "Mid-game observation: ", "Ledger assessment: ", "Sampled balance: ", "Change record: ", "Event assessment: ", "Principal observation: "],
    aftermath: ["Disposition: ", "Final observation: ", "Closing record: ", "Post-match assessment: ", "Recorded outcome: ", "Final ledger: ", "After-action note: ", "Closing evidence: ", "Summary observation: ", "End-state record: ", "Post-game finding: ", "Final assessment: "],
  },
};

export function phrasebank(tone: ReportTone, beat: ReportBeat): ReportTemplate[] {
  return prefixes[tone][beat].map((prefix, index) => ({ id: `${tone}:${beat}:${index}`, pattern: `${prefix}{fact}` }));
}

const BANNED = /\b(?:idiot|stupid|noob|moron|trash|pathetic|humiliated|destroyed their spirit)\b/i;
export function lintTemplate(template: ReportTemplate): string[] {
  const slots = template.pattern.match(/\{[^}]*\}/g) ?? [];
  return [...(slots.length !== 1 || slots[0] !== "{fact}" ? ["Template needs exactly one supported fact slot"] : []), ...(BANNED.test(template.pattern) ? ["Template contains banned language"] : [])];
}
