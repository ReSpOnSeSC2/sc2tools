"use client";
import { useRouter } from "next/navigation";
import { PublicUnavailable } from "@/components/public-profile/PublicUnavailable";

export default function ProfileError({ reset }: { error: Error; reset: () => void }) {
  const router = useRouter();
  return <PublicUnavailable surface="profile" reason="outage" onRetry={() => { reset(); router.refresh(); }} />;
}
