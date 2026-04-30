const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

function _salvageJsonObject(text) {
    if (typeof text !== 'string' || text.length === 0) return null;
    let trimmed = text.replace(/[\s ]+$/, '');
    if (trimmed.endsWith(',')) trimmed = trimmed.slice(0, -1);
    const candidates = [trimmed + '\n}\n'];
    const BOUND_RE = /},\s*\n/g;
    const bounds = [];
    let m;
    while ((m = BOUND_RE.exec(text)) !== null && bounds.length < 200) bounds.push(m.index);
    for (let i = bounds.length - 1; i >= 0; i--) candidates.push(text.slice(0, bounds[i] + 1) + '\n}\n');
    for (const c of candidates) {
        try { const p = JSON.parse(c); if (p && typeof p === 'object' && !Array.isArray(p)) return p; } catch (_) {}
    }
    return null;
}

function tryFile(p, label) {
    let raw = fs.readFileSync(p, 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    let parsed;
    try { parsed = JSON.parse(raw); console.log(label, 'clean parse'); }
    catch (_) { parsed = _salvageJsonObject(raw); console.log(label, 'salvaged:', !!parsed); }
    console.log(label, 'entries:', Object.keys(parsed || {}).length);
    return parsed || {};
}

const data = tryFile(path.join(ROOT, 'data/MyOpponentHistory.json'), '[modern]');
const legacy = tryFile(path.join(ROOT, 'MyOpponentHistory.json'), '[legacy]');
const meta = tryFile(path.join(ROOT, 'data/meta_database.json'), '[meta]');

let fii = false;
for (const id of Object.keys(legacy)) {
    if ((legacy[id].Name||'').toLowerCase().includes('fiiclick')) {
        const r = legacy[id];
        let w = r.Wins||0, l = r.Losses||0;
        if (r.Matchups) for (const mu of Object.keys(r.Matchups)) { w += r.Matchups[mu].Wins||0; l += r.Matchups[mu].Losses||0; }
        console.log('  legacy:', JSON.stringify(r.Name), 'W:', w, 'L:', l);
        fii = true;
    }
}
console.log('  FIIClicK present in salvaged legacy:', fii);

let mn = 0, mw = 0, ml = 0;
for (const bd of Object.values(meta)) {
    if (Array.isArray(bd.games)) for (const g of bd.games) {
        if ((g.opponent||'').toLowerCase().includes('fiiclick')) {
            mn++;
            const r = String(g.result||'').toLowerCase();
            if (r === 'win' || r === 'victory') mw++;
            else if (r === 'loss' || r === 'defeat') ml++;
        }
    }
}
console.log('  FIIClicK in salvaged meta DB:', mn ? `${mw}W-${ml}L (${mn} games)` : 'none');
