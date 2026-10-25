import { Badge } from "./Badge";

export function ResultBadge({ result }: { result?: string | null }) {
  const value = result?.trim().toLowerCase();
  const label = value === "win" || value === "victory" ? "Win" : value === "loss" || value === "defeat" ? "Loss" : value === "tie" || value === "draw" ? "Tie" : "Unknown";
  return <Badge size="sm" variant={label === "Win" ? "success" : label === "Loss" ? "danger" : "neutral"}>{label}</Badge>;
}
