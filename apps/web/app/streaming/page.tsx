import { redirect } from "next/navigation";

export const metadata = {
  title: "Streaming · SC2 Tools",
};

/**
 * Legacy /streaming route. The streaming overlay manager moved to
 * /settings (Overlay tab) so the page chrome only carries one
 * "configure your account" entry point. Anyone who deep-linked to
 * /streaming gets bounced to the new home.
 */
export default function StreamingPage(): never {
  redirect("/settings#overlay");
}
