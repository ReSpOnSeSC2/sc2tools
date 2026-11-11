"use client";

import dynamic from "next/dynamic";

// Split the interactive chart at a client boundary while retaining the bars
// and accessible data table in the server-rendered HTML.
export const LazyCiBarChart = dynamic(() =>
  import("@/components/guides/CiBarChart").then((mod) => mod.CiBarChart),
);
