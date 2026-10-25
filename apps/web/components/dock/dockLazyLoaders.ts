/** Factories stay stable across parent edits; each explicit Retry invokes import() again. */
export const loadBuildVote = () => import("./DockBuildVote").then(module => module.DockBuildVote);
export const loadBrollLibrary = () => import("./BrollLibraryEditor").then(module => module.BrollLibraryEditor);
export const loadBuildProfileChart = () => import("@/components/overlay/widgets/BuildProfileWidget").then(module => module.BuildProfileChart);
