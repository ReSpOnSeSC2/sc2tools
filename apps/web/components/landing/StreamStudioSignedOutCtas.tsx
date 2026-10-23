import Link from "next/link";
import { Download } from "lucide-react";
import { buttonClassName } from "@/components/ui/buttonStyles";

export function StreamStudioSignedOutCtas() {
  return <><Link href="/download" className={buttonClassName({ size: "lg" })}><Download className="h-5 w-5" aria-hidden />Download the free agent</Link><Link href="/sign-up" className={buttonClassName({ variant: "secondary", size: "lg" })}>Create a free account</Link></>;
}
