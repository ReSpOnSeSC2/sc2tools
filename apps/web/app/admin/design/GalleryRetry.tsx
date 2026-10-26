"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";

export function GalleryRetry() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return <Button variant="secondary" loading={pending} onClick={() => startTransition(() => router.refresh())}>Check access again</Button>;
}
