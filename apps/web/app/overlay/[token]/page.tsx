import { OverlayClient } from "@/components/OverlayClient";

export const metadata = {
  title: "Live overlay",
  robots: { index: false, follow: false },
};

export default async function OverlayPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <OverlayClient token={token} />;
}
