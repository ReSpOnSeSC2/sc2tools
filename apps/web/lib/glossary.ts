/**
 * Glossary: the short, plain definitions of terms the analyzer uses
 * without explaining them on screen (Pulse ID, Net MMR, …). Each term
 * points at the help article section that explains it in full, so an
 * info tip beside a column header or a toggle can say one sentence and
 * link to the rest.
 *
 * Plain data, like the help articles; the help tests check that every
 * `help` link resolves to a real article and heading anchor. Add a term
 * here before adding a tip for it in the UI.
 *
 * Deliberately free of imports: an info tip that reads one definition
 * must not pull every help article into its page's bundle.
 */

/** Topic a term belongs to, for grouping on a glossary page. */
export type GlossaryCategory = "opponents" | "mmr";

export interface GlossaryTerm {
  /** Stable id: lowercase letters, digits and hyphens. */
  id: string;
  /** The term as it appears on screen. */
  term: string;
  /** One plain sentence, short enough for a tooltip. */
  short: string;
  /** Optional second sentence or two for a glossary page. */
  long?: string;
  /** Ids of related terms. */
  related: string[];
  category: GlossaryCategory;
  /** Where the term is explained in full: a help article and, optionally, one of its heading anchors. */
  help: { slug: string; anchor?: string };
}

export const GLOSSARY: readonly GlossaryTerm[] = [
  {
    id: "pulse-id",
    term: "Pulse ID",
    short: "A player's ID on SC2Pulse, the public ladder site. It stays the same when they change their name.",
    long: "It brings their current MMR, league and linked accounts. Until it's found, SC2 Tools shows the player's toon instead.",
    related: ["toon", "group-same-player"],
    category: "opponents",
    help: { slug: "opponents", anchor: "pulse-id" },
  },
  {
    id: "toon",
    term: "Toon",
    short: "The account ID inside a replay, such as 1-S2-1-267727: region, realm and account number.",
    long: "Every replay has one, so it identifies an opponent even before their Pulse ID is known.",
    related: ["pulse-id"],
    category: "opponents",
    help: { slug: "opponents", anchor: "pulse-id" },
  },
  {
    id: "net-mmr",
    term: "Net MMR",
    short: "The MMR you gained or lost against an opponent in total, from verified pairs of ranked games.",
    related: ["verified-pairs", "mmr-impact"],
    category: "mmr",
    help: { slug: "opponents", anchor: "net-mmr" },
  },
  {
    id: "verified-pairs",
    term: "Verified pairs",
    short: "Two ranked 1v1 games in a row on the same account and race. The MMR change of the first game is the start MMR of the second minus its own.",
    long: "Pairs with a change bigger than 150 MMR are left out, because something happened in between that the replays don't show.",
    related: ["net-mmr", "mmr-impact"],
    category: "mmr",
    help: { slug: "opponents", anchor: "net-mmr" },
  },
  {
    id: "mmr-impact",
    term: "MMR impact",
    short: "Which opponents you've won the most MMR from, and lost the most MMR to, counted from verified pairs.",
    related: ["net-mmr", "verified-pairs"],
    category: "mmr",
    help: { slug: "opponents", anchor: "mmr-impact" },
  },
  {
    id: "group-same-player",
    term: "Group same player",
    short: "Merges accounts that SC2Pulse links to the same player, or that are confirmed as the same person, into one row.",
    related: ["pulse-id", "barcode"],
    category: "opponents",
    help: { slug: "opponents", anchor: "group-same-player" },
  },
  {
    id: "barcode",
    term: "Barcode",
    short: "A name made only of look-alike characters, such as IIlIlI, used to hide who's playing.",
    long: "When the player behind it is known, from SC2Pulse or an identity confirmed by our team, their real name shows next to it.",
    related: ["group-same-player", "pulse-id"],
    category: "opponents",
    help: { slug: "opponent-dossier", anchor: "barcode" },
  },
];

const BY_ID: ReadonlyMap<string, GlossaryTerm> = new Map(GLOSSARY.map((term) => [term.id, term]));

/**
 * The term with this id, if any.
 *
 * Example: `glossaryTerm("net-mmr")?.term` → "Net MMR".
 */
export function glossaryTerm(id: string): GlossaryTerm | undefined {
  return BY_ID.get(id);
}

/**
 * Public URL of the help section that explains a term.
 *
 * Example: `glossaryHelpPath(glossaryTerm("net-mmr")!)` → "/help/opponents#net-mmr".
 */
export function glossaryHelpPath(term: GlossaryTerm): string {
  const article = `/help/${term.help.slug}`;
  return term.help.anchor ? `${article}#${term.help.anchor}` : article;
}
