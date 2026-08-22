import { OpponentProfileRoute } from "@/components/analyzer/OpponentProfileRoute";

export const metadata = {
  title: "Opponent dossier · SC2 Tools",
  description:
    "Head-to-head record, build tendencies, and likely strategies for one opponent.",
};

/**
 * /app/opponents/[pulseId] — one opponent's dossier as a real,
 * linkable URL. The id is the durable SC2Pulse character id, so the
 * link survives the opponent renaming themselves.
 */
export default async function OpponentDossierPage({
  params,
}: {
  params: Promise<{ pulseId: string }>;
}) {
  const { pulseId } = await params;
  return <OpponentProfileRoute pulseId={safeDecode(pulseId)} />;
}

/** Row links encode the id; decode defensively (older links may not). */
function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
