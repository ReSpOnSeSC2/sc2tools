import type { ReportCardClass } from "./reportCardRoute";

export const REPORT_CARD_METADATA = {
  summary: {
    title: "StarCraft II replay report",
    kind: "Replay report",
    subtitle: "View selected replay results and make your own report.",
  },
  compare: {
    title: "StarCraft II replay comparison",
    kind: "Replay comparison",
    subtitle: "Compare two sets of selected replay results.",
  },
} satisfies Record<ReportCardClass, { title: string; kind: string; subtitle: string }>;

export const REPORT_CARD_DISCLOSURE = "The numbers are self-reported by the person who shared this card.";
