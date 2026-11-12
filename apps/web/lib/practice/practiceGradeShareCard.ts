import type { GhostGradeLetter } from "@/lib/ghostGrade";
import type { PersonalShareCard } from "@/lib/personalShareCards";

export type PracticeGradeCredit = { title: string; creator: string; path: `/b/${string}` };

export function practiceGradeShareCard({ title, creator, path }: PracticeGradeCredit, letter: GhostGradeLetter): PersonalShareCard {
  return {
    kind: "practice_grade", title: "Practice Link grade", subtitle: `${title} · Build by ${creator}`, path,
    stats: [{ label: "Grade", value: letter }],
  };
}
