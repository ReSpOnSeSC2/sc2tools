import { Suspense } from "react";
import type { Metadata } from "next";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { AuthorizedGallery } from "./AuthorizedGallery";

export const metadata: Metadata = { title: "Design gallery · Admin", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/** AdminShell supplies navigation, not authorization. Never mount the gallery
 * until the API has confirmed this request's current authenticated account. */
export default function DesignPage() {
  return <Suspense fallback={<SkeletonRows rows={3} label="Checking gallery access" />}><AuthorizedGallery /></Suspense>;
}

