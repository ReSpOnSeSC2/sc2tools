export const RAIL_KEY = "sc2tools:rail:v1";
export function readRailPinned(): boolean {
  let saved: string | null = null;
  try { saved = window.localStorage.getItem(RAIL_KEY); } catch { /* Use device default. */ }
  if (saved === "pinned" || saved === "collapsed") return saved === "pinned";
  return window.matchMedia?.("(min-width:1536px)")?.matches === true || window.matchMedia?.("(hover: none)")?.matches === true;
}
/** Runs before paint; a failed storage read still uses the device default. */
export const RAIL_BOOTSTRAP = `(function(){try{var r=null;try{r=localStorage.getItem('sc2tools:rail:v1')}catch(e){}var p=r==='pinned'||(r!=='collapsed'&&(matchMedia('(min-width:1536px)')?.matches||matchMedia('(hover: none)')?.matches));document.documentElement.setAttribute('data-rail',p?'pinned':'collapsed')}catch(e){}})();`;
