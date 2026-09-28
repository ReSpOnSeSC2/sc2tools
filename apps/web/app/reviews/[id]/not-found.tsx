"use client";

import { useParams } from "next/navigation";
import { ReviewNotFound } from "@/components/reviews/ReviewNotFound";

export default function ReviewNotFoundPage() {
  const params = useParams<{ id?: string }>();
  return <ReviewNotFound id={typeof params?.id === "string" ? params.id : null} />;
}
