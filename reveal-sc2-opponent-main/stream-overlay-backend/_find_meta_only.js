const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
function _salvage(text) {
    let trimmed = text.replace(/[\s ]+$/, '');
    if (trimmed.endsWith(',')) trimmed = trimmed.slice(0, -1);
    const cands = [trimmed + '\n}\n'];
    const RE = /},\s*\n/g;
    const bs = []; let m;
    while ((m = RE.exec(text)) !== null && bs.length < 200) bs.push(m.index);
    for (let i = bs.length - 1; i >= 0; i--) cands.push(text.slice(0, bs[i] + 1) + '\n}\n');
    for (const c of cands) {
        try { const p = JSON.parse(c); if (p && typeof p === 'object' && !Array.isArray(p)) return p; } catch(_){}
    }
    return null;
}
function load(p) {
    let raw = fs.readFileSync(p, 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    try { return JSON.parse(raw); } catch (_) { return _salvage(raw) || {}; }
}
const data = load(path.join(ROOT, 'data/MyOpponentHistory.json'));
const legacy = load(path.join(ROOT, 'MyOpponentHistory.json'));
const meta = load(path.join(ROOT, 'data/meta_database.json'));

// Build set of all names known to either history.
function nameForms(name) {
    if (!name) return new Set();
    const out = new Set();
    const add = s => { if (s) out.add(String(s).toLowerCase().trim()); };
    add(name);
    if (String(name).includes(']')) add(String(name).split(']').pop().trim());
    const i = String(name).lastIndexOf('#');
    if (i >= 0) add(String(name).slice(0, i));
    return out;
}
const known = new Set();
for (const r of Object.values(data))   { for (const f of nameForms(r.Name||'')) known.add(f); }
for (const r of Object.values(legacy)) { for (const f of nameForms(r.Name||'')) known.add(f); }
console.log('known opponents (combined):', known.size);

// Find meta DB games whose opponent has NO history entry.
const candidates = new Map(); // opp name -> {wins, losses}
for (const bd of Object.values(meta)) {
    if (!Array.isArray(bd.games)) continue;
    for (const g of bd.games) {
        const opp = g.opponent;
        if (!opp) continue;
        const forms = nameForms(opp);
        let inHistory = false;
        for (const f of forms) if (known.has(f)) { inHistory = true; break; }
        if (inHistory) continue;
        const c = candidates.get(opp.toLowerCase()) || { name: opp, wins: 0, losses: 0 };
        const r = String(g.result||'').toLowerCase();
        if (r === 'win' || r === 'victory') c.wins++;
        else if (r === 'loss' || r === 'defeat') c.losses++;
        candidates.set(opp.toLowerCase(), c);
    }
}
const all = Array.from(candidates.values()).filter(c => c.wins + c.losses >= 2)
                .sort((a,b) => (b.wins+b.losses) - (a.wins+a.losses));
console.log('meta-only opponents with 2+ games:', all.length);
console.log(all.slice(0, 5));
