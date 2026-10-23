export type NotificationRow = { id: string; kind: string; title: string; body: string; href: string | null; count: number; readAt: string | null; createdAt: string };
export type NotificationPage = { items: NotificationRow[]; nextCursor: string | null };
export type NotificationCategory = "all" | "reviews" | "coaching" | "system";
export const NOTIFICATION_CATEGORIES: NotificationCategory[] = ["all", "reviews", "coaching", "system"];
export const CATEGORY_LABELS = { all: "All", reviews: "Reviews", coaching: "Coaching", system: "System" };
export const NOTIFICATION_KINDS = [
  ["review.new", "New reviews"], ["review.reply", "Review replies"], ["review.helpful", "Helpful review marks"],
  ["review.best", "Best review marks"], ["review.digest", "Review digest"], ["coaching.booked", "Session bookings"],
  ["coaching.cancelled", "Session cancellations"], ["coaching.assigned", "Practice assignments"],
  ["coaching.practice_sharing_requested", "Practice sharing requests"], ["coaching.practice_sharing_accepted", "Practice sharing accepted"],
  ["coaching.practice_sharing_rejected", "Practice sharing declined"], ["coaching.practice_sharing_revoked", "Practice sharing revoked"],
  ["import.done", "Import finished"], ["agent.update_required", "Required desktop app updates"],
  ["community.vote", "Community build upvotes"], ["support.status", "Report status changes"], ["support.reply", "Replies to reports"],
] as const;
export function notificationCategory(kind: string): NotificationCategory {
  return kind.startsWith("review.") ? "reviews" : kind.startsWith("coaching.") ? "coaching" : "system";
}
export function fmtAgo(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return "Just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
export const notificationFocus = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg";
