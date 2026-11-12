"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";

export default function StreamViewerError({ reset }: { reset: () => void }) {
  const router = useRouter();
  return <article className="mx-auto w-full max-w-3xl space-y-5 px-4 py-8 sm:px-6">
    <h1 className="font-display text-h1 font-bold text-text">Stream viewer</h1>
    <Card title="Results unavailable" headingLevel={2}>
      <p role="status" className="mb-4 text-body text-text-muted">The latest results couldn't load.</p>
      <Button variant="secondary" className="min-h-11" onClick={() => { reset(); router.refresh(); }}>Try again</Button>
    </Card>
  </article>;
}
