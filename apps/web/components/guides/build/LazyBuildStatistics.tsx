"use client";

import dynamic from "next/dynamic";

// Keep the secondary controls out of the route entry while rendering their
// tables, native disclosures and mobile snapshot cards on the server.
export const BuildMatchupGroup = dynamic(() =>
  import("./BuildMatchupTables").then((module) => module.BuildMatchupGroup),
);

export const BuildAllMaps = dynamic(() =>
  import("./BuildMatchupTables").then((module) => module.BuildAllMaps),
);

export const ArmyMobileTabs = dynamic(() =>
  import("./ArmyMobileTabs").then((module) => module.ArmyMobileTabs),
);
