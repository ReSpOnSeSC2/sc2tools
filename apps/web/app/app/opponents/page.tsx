import { OpponentsRoute } from "@/components/analyzer/OpponentsRoute";

export const metadata = {
  title: "Opponents · SC2 Tools",
  description:
    "A permanent record of every player you've faced — keyed to their persistent SC2Pulse ID.",
};

/** /app/opponents — the opponent list. Rows navigate to per-opponent dossiers. */
export default function OpponentsPage() {
  return <OpponentsRoute />;
}
