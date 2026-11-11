import { ShareButton } from "@/components/ui/ShareButton";

export interface ShareLinkButtonProps {
  path: string;
  label?: string;
  className?: string;
}

export function ShareLinkButton({ path, label = "Share link", className }: ShareLinkButtonProps) {
  return <ShareButton path={path} label={label} className={className} variant="ghost" size="sm" copiedLabel="Copied!" fullWidth />;
}
