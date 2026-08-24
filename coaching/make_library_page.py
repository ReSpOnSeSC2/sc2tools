#!/usr/bin/env python3
"""Generate the SC2 Tools Coaching build-library web page from coaching_builds.json.

Usage: python make_library_page.py coaching_builds.json -o build_library.html
Re-run each season after extract_builds.py to refresh the page.
"""
import argparse, json

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("refs")
    ap.add_argument("-o", "--out", default="build_library.html")
    args = ap.parse_args()
    refs = json.load(open(args.refs, encoding="utf-8"))
    # slim payload for the page
    slim = {"season": refs["season"], "coach": refs["coach"], "source_games": refs["source_games"],
            "builds": [{k: b[k] for k in ("id", "name", "matchup", "games", "wins", "losses",
                                          "winrate", "from_current_season", "exemplar",
                                          "order", "chrono_plan", "benchmarks")}
                       for b in refs["builds"]]}
    data = json.dumps(slim).replace("</", "<\\/")
    html = PAGE.replace("__DATA__", data)
    open(args.out, "w", encoding="utf-8").write(html)
    print(f"library page -> {args.out} ({len(slim['builds'])} builds)")

PAGE = r"""<title>ReSpOnSe Build Library</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
:root{
  --bg:#0a0d14; --panel:#101622; --panel2:#141c2b; --line:#202b3e; --ink:#d9e2f0;
  --mute:#7f8ca3; --gold:#d4a843; --gold-dim:#8a6f2f; --blue:#5aa7ff; --win:#43b581; --loss:#e06c6c;
  --mono:'IBM Plex Mono',ui-monospace,Consolas,monospace;
}
*{box-sizing:border-box} html,body{margin:0}
body{background:var(--bg);color:var(--ink);font:15px/1.55 'IBM Plex Sans',system-ui,sans-serif;min-height:100vh}
h1,h2,h3,.d{font-family:'Rajdhani','IBM Plex Sans',sans-serif}
.wrap{max-width:1150px;margin:0 auto;padding:28px 20px 60px}
header .eyebrow{color:var(--gold);font-family:'Rajdhani',sans-serif;font-weight:600;letter-spacing:.22em;text-transform:uppercase;font-size:12px}
h1{font-size:40px;line-height:1.05;margin:6px 0 4px;font-weight:700;letter-spacing:.01em;text-wrap:balance}
.sub{color:var(--mute);max-width:62ch}
.season{display:inline-block;border:1px solid var(--gold-dim);color:var(--gold);border-radius:4px;padding:1px 10px;font-family:'Rajdhani',sans-serif;font-weight:600;letter-spacing:.08em;margin-left:8px;font-size:13px;vertical-align:middle}
.layout{display:grid;grid-template-columns:290px 1fr;gap:22px;margin-top:26px}
@media(max-width:820px){.layout{grid-template-columns:1fr}}
nav.mu{display:flex;gap:6px;margin-bottom:12px}
nav.mu button{flex:1;background:var(--panel);border:1px solid var(--line);color:var(--mute);font-family:'Rajdhani',sans-serif;font-weight:700;font-size:16px;letter-spacing:.1em;padding:8px 0;border-radius:6px;cursor:pointer}
nav.mu button.on{color:var(--gold);border-color:var(--gold-dim);background:var(--panel2)}
nav.mu button:focus-visible,.copy:focus-visible,.blist button:focus-visible{outline:2px solid var(--blue);outline-offset:2px}
.blist{display:flex;flex-direction:column;gap:6px}
.blist button{display:block;width:100%;text-align:left;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:9px 12px;color:var(--ink);cursor:pointer;font:inherit}
.blist button.on{border-color:var(--gold-dim);background:var(--panel2)}
.blist .nm{font-weight:600;font-size:14px}
.meter{height:4px;background:#1c2534;border-radius:2px;margin-top:7px;overflow:hidden}
.meter i{display:block;height:100%;background:linear-gradient(90deg,var(--gold-dim),var(--gold))}
.blist .wr{color:var(--mute);font-size:12px;margin-top:5px;display:flex;justify-content:space-between}
.wr b{color:var(--ink);font-weight:500}
.sheet{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:22px 24px}
.sheet h2{font-size:27px;margin:0;font-weight:700}
.tags{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0 4px}
.tag{font-size:12px;border-radius:4px;padding:2px 9px;font-family:'Rajdhani',sans-serif;font-weight:600;letter-spacing:.06em;border:1px solid var(--line);color:var(--mute)}
.tag.g{color:var(--gold);border-color:var(--gold-dim)}
.tag.w{color:var(--win);border-color:#2b5643}
.tag.s{color:var(--loss);border-color:#5c3434}
.src{color:var(--mute);font-size:13px;margin:8px 0 0}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:18px}
@media(max-width:980px){.grid2{grid-template-columns:1fr}}
.box{background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:14px 16px;overflow-x:auto}
.box h3{margin:0 0 10px;font-size:15px;letter-spacing:.14em;text-transform:uppercase;color:var(--blue);font-weight:600}
table{border-collapse:collapse;width:100%;font-family:var(--mono);font-size:12.5px;font-variant-numeric:tabular-nums}
th{color:var(--mute);text-align:left;font-weight:500;border-bottom:1px solid var(--line);padding:3px 8px;font-family:'IBM Plex Sans',sans-serif;font-size:11.5px;letter-spacing:.05em;text-transform:uppercase}
td{padding:2.5px 8px;border-bottom:1px solid #182234;white-space:nowrap}
td.mu,span.mu{color:var(--mute)}
.chrono{font-family:var(--mono);font-size:12.5px;color:var(--mute);line-height:2}
.chrono b{color:var(--blue);font-weight:500}
.copy{background:none;border:1px solid var(--gold-dim);color:var(--gold);border-radius:6px;padding:6px 14px;font-family:'Rajdhani',sans-serif;font-weight:700;letter-spacing:.08em;font-size:14px;cursor:pointer;margin-top:12px}
.copy:hover{background:#d4a84314}
.foot{margin-top:26px;color:var(--mute);font-size:13px;border-top:1px solid var(--line);padding-top:14px;max-width:75ch}
.foot b{color:var(--ink);font-weight:500}
@media(prefers-reduced-motion:no-preference){.sheet{animation:in .18s ease}}
@keyframes in{from{opacity:.4;transform:translateY(3px)}to{opacity:1;transform:none}}
</style>
<div class="wrap">
<header>
  <div class="eyebrow">SC2 Tools Coaching · Protoss</div>
  <h1>ReSpOnSe Build Library<span class="season" id="season"></span></h1>
  <p class="sub">Every build on this page is generated from my own ladder games — the cited replay is real, the
  benchmark column is my median over every game of the build, and the win rate is measured, not promised.
  Your submitted replays are graded against these exact timings.</p>
</header>
<div class="layout">
  <aside>
    <nav class="mu" id="mu" aria-label="Matchup"></nav>
    <div class="blist" id="blist"></div>
  </aside>
  <main class="sheet" id="sheet" aria-live="polite"></main>
</div>
<p class="foot" id="foot"></p>
</div>
<script>
const DATA=__DATA__;
const MUS=["PvT","PvZ","PvP"];
let mu="PvT", sel=null;
const $=id=>document.getElementById(id);
document.title="ReSpOnSe Build Library";
$("season").textContent="Season "+DATA.season;
$("foot").innerHTML="<b>How grading works:</b> hit each milestone within 12 seconds of the median for full credit; "+
 "credit fades to zero at 90 seconds off. Buildings weigh double. Play your assigned build, submit the replay, and "+
 "your report card comes back the same day. Library generated from "+DATA.source_games+" parsed games · sc2tools.com";
function builds(){return DATA.builds.filter(b=>b.matchup===mu).sort((a,b)=>b.games-a.games)}
function esc(s){return String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]))}
function renderNav(){
  $("mu").innerHTML=MUS.map(m=>`<button class="${m===mu?'on':''}" onclick="setMu('${m}')">${m}</button>`).join("");
  $("blist").innerHTML=builds().map(b=>`<button class="${b.id===sel?'on':''}" onclick="setSel('${b.id}')">
    <div class="nm">${esc(b.name.replace(/^Pv. - /,''))}</div>
    <div class="meter"><i style="width:${b.winrate}%"></i></div>
    <div class="wr"><span><b>${b.winrate}%</b> win rate</span><span>${b.wins}–${b.losses}</span></div></button>`).join("");
}
function setMu(m){mu=m;sel=builds()[0]?.id||null;renderNav();renderSheet()}
function setSel(id){sel=id;renderNav();renderSheet()}
function clock(t){return Math.floor(t/60)+":"+String(t%60).padStart(2,"0")}
function renderSheet(){
  const b=DATA.builds.find(x=>x.id===sel); if(!b){$("sheet").innerHTML="";return}
  const ex=b.exemplar;
  const orows=b.order.map(o=>`<tr><td>${o.supply.toFixed(0)}</td><td>${o.clock}</td><td style="white-space:normal">${esc(o.name)}</td><td class="mu">${o.type}</td></tr>`).join("");
  const brows=b.benchmarks.map(m=>`<tr><td style="white-space:normal">${esc(m.milestone)}</td><td>${m.median_clock}</td><td>${m.median_supply}</td><td class="mu">${m.spread_s!=null?"±"+Math.round(m.spread_s/2)+"s":"—"}</td><td class="mu">${m.samples}</td></tr>`).join("");
  const chr=b.chrono_plan.slice(0,10).map(c=>`<b>${c.clock}</b> ${esc(c.target)}`).join(" &nbsp;·&nbsp; ")||"—";
  $("sheet").innerHTML=`
   <h2>${esc(b.name)}</h2>
   <div class="tags">
     <span class="tag w">${b.winrate}% over ${b.games} games</span>
     <span class="tag g">graded build</span>
     ${b.from_current_season?"":'<span class="tag s">pre-season reference — newest on record</span>'}
   </div>
   <p class="src">Reference game: ${esc(ex.map)} vs ${esc(ex.opponent||"?")} (${esc(ex.opp_race||"?")}) — ${esc((ex.date||"").slice(0,10))}, ${esc(ex.result||"")}</p>
   <div class="grid2">
     <div class="box"><h3>Supply-by-supply opening</h3>
       <table><tr><th>Sup</th><th>Clock</th><th>Action</th><th></th></tr>${orows}</table>
       <button class="copy" onclick="copyBuild('${b.id}',this)">Copy build order</button></div>
     <div class="box"><h3>Graded benchmarks</h3>
       <table><tr><th>Milestone</th><th>Median</th><th>@Sup</th><th>Spread</th><th>n</th></tr>${brows}</table>
       <h3 style="margin-top:14px">Chrono plan</h3><div class="chrono">${chr}</div></div>
   </div>`;
}
function copyBuild(id,btn){
  const b=DATA.builds.find(x=>x.id===id);
  const txt=[b.name+"  ("+b.winrate+"% over "+b.games+" games, ReSpOnSe / SC2 Tools Coaching, season "+DATA.season+")","",
    ...b.order.map(o=>String(o.supply.toFixed(0)).padStart(3)+"  "+o.clock.padStart(5)+"  "+o.name),"",
    "Benchmarks (median):",...b.benchmarks.map(m=>"  "+m.median_clock.padStart(5)+"  @"+m.median_supply+"  "+m.milestone)].join("\n");
  const ok=()=>{btn.textContent="Copied ✓";setTimeout(()=>btn.textContent="Copy build order",1500)};
  const legacy=()=>{const ta=document.createElement("textarea");ta.value=txt;document.body.appendChild(ta);
    ta.select();try{document.execCommand("copy");ok()}catch(e){btn.textContent="Copy failed"}ta.remove()};
  if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(txt).then(ok).catch(legacy)}else{legacy()}
}
setMu("PvT");
</script>
"""

if __name__ == "__main__":
    main()
