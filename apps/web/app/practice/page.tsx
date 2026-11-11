import { PracticeLogPage } from "@/components/practice/PracticeLogPage";

export const metadata = {
  title: "Practice log",
  description: "Your private Ghost Build grades: every game in a practised matchup, graded automatically, with your progress.",
};

export default function PracticeRoute() {
  return <PracticeLogPage />;
}
