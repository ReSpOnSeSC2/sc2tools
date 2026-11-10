import { GoalsPage } from "@/components/goals/GoalsPage";

export const metadata = {
  title: "Goals",
  description: "Personal goals with automatic progress from your replays: games, win rate, MMR, macro and build practice.",
};

/** /app/goals — personal goals (components/goals/GoalsPage.tsx). */
export default function GoalsRoute() {
  return <GoalsPage />;
}
