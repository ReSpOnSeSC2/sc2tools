"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/Button";

export function GuideRetryButton({ onRetry }: { onRetry?: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return <Button disabled={pending} aria-busy={pending || undefined} onClick={() => {
    if (!pending) startTransition(() => onRetry ? onRetry() : router.refresh());
  }}>{pending ? <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden /> : null}Try again</Button>;
}
