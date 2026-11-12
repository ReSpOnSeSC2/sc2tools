import { Card } from "@/components/ui/Card";

export default function StreamViewerNotFound() {
  return <article className="mx-auto w-full max-w-3xl space-y-5 px-4 py-8 sm:px-6">
    <h1 className="font-display text-h1 font-bold text-text">Stream viewer</h1>
    <Card title="Viewer page unavailable" headingLevel={2}>
      <p className="text-body text-text-muted">This page is private, no longer shared, or the link is incorrect.</p>
    </Card>
  </article>;
}
