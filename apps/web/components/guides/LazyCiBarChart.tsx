import dynamic from "next/dynamic";

/**
 * CiBarChart as its own client chunk. Imported from server components:
 * next/dynamic keeps SSR on (the default — `ssr: false` is not allowed
 * in server components), so the HTML already contains the bars and the
 * sr-only data table, and the chart's JS is split from the page bundle.
 */
export const LazyCiBarChart = dynamic(() =>
  import("@/components/guides/CiBarChart").then((mod) => mod.CiBarChart),
);
