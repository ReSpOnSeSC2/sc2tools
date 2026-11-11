"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

function navigationHref(event: MouseEvent) {
  if (event.defaultPrevented || event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
  if (!anchor || anchor.hasAttribute("download") || anchor.target && anchor.target.toLowerCase() !== "_self") return null;
  const target = new URL(anchor.href, window.location.href);
  if (target.origin !== window.location.origin || target.pathname === window.location.pathname && target.search === window.location.search) return null;
  return `${target.pathname}${target.search}${target.hash}`;
}

/** Guard normal navigation. The caller keeps a recoverable draft for history navigation. */
export function useUnsavedChangesGuard(dirty: boolean) {
  const router = useRouter();
  const [href, setHref] = useState<string | null>(null);
  useEffect(() => {
    if (!dirty) return;
    const unload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    const click = (event: MouseEvent) => {
      const target = navigationHref(event);
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      setHref(target);
    };
    window.addEventListener("beforeunload", unload);
    document.addEventListener("click", click, true);
    return () => {
      window.removeEventListener("beforeunload", unload);
      document.removeEventListener("click", click, true);
    };
  }, [dirty]);

  return {
    open: href !== null,
    stay: () => setHref(null),
    leave: () => {
      if (!href) return;
      setHref(null);
      router.push(href);
    },
  };
}
