import { auth } from "@clerk/nextjs/server";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";
export const metadata = { title: "Bot practice", robots: { index: false, follow: false } };

/** This development surface has no public navigation or shared client import. */
export default async function BotLabPage() {
  if (process.env.BOT_LAB_ENABLED !== "true") notFound();
  const { userId } = await auth();
  const admins = new Set((process.env.SC2TOOLS_ADMIN_USER_IDS ?? "").split(/[\s,]+/).filter(Boolean));
  if (!userId || !admins.has(userId)) notFound();
  const { BotLab } = await import("./BotLab");
  return <BotLab />;
}
