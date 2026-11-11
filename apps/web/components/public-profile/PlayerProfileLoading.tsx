import { Card, Skeleton } from "@/components/ui/Card";

export default function LoadingPlayer() {
  return <div className="min-w-0 space-y-6" role="status" aria-label="Loading player profile">
    <Card variant="feature" className="min-h-36"><Skeleton rows={3} /></Card>
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {["games", "record", "rate", "matchup"].map((key) => <Card key={key}><Skeleton rows={2} /></Card>)}
    </div>
    <div className="grid gap-6 lg:grid-cols-2">
      <Card><Skeleton rows={4} /></Card><Card><Skeleton rows={4} /></Card>
    </div>
  </div>;
}
