const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
function _salvageJsonObject(text) {
    let trimmed = text.replace(/[\s ]+$/, '');
    if (trimmed.endsWith(',')) trimmed = trimmed.slice(0, -1);
    const candidates = [trimmed + '\n}\n'];
    const BOUND_RE = /},\s*\n/g;
    const bounds = [];
    let m;
    while ((m = BOUND_RE.exec(text)) !== null && bounds.length < 200) bounds.push(m.index);
    for (let i = bounds.length - 1; i >= 0; i--) candidates.push(text.slice(0, bounds[i] + 1) + '\n}\n');
    for (const c of candidates) {
        try { const p = JSON.parse(c); if (p && typeof p === 'object' && !Array.isArray(p)) return p; } catch(_){}
    }
    return null;
}

let raw = fs.readFileSync(path.join(ROOT, 'data/MyOpponentHistory.json'), 'utf8');
if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
let h;
try { h = JSON.parse(raw); } catch (_) { h = _salvageJsonObject(raw); }
console.log('modern entries after salvage:', Object.keys(h).length);
let n = 0;
for (const id of Object.keys(h)) {
    if ((h[id].Name||'').toLowerCase().includes('fiiclick')) {
        n++;
        const r = h[id];
        let w = r.Wins||0, l = r.Losses||0;
        if (r.Matchups) for (const mu of Object.keys(r.Matchups)) { w += r.Matchups[mu].Wins||0; l += r.Matchups[mu].Losses||0; }
        console.log('FOUND in modern:', id, JSON.stringify(r.Name), 'W:', w, 'L:', l);
    }
}
console.log('FIIClicK present in MODERN file (after salvage):', n);
