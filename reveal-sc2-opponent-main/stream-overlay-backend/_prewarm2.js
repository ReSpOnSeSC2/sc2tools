const a = require('./analyzer.js');
const express = require('express');
const app = express();
app.use('/api/analyzer', a.router);
const server = app.listen(0, async () => {
  const port = server.address().port;
  const games = await fetch(`http://127.0.0.1:${port}/api/analyzer/games?limit=10000`).then(r => r.json());
  const maps = [...new Set(games.games.map(g => g.map).filter(Boolean))].sort();
  // Skip ones already cached
  const fs = require('fs');
  const cacheDir = require('path').resolve('../data/map-images');
  const cached = new Set(fs.readdirSync(cacheDir).map(f => f.replace(/\.[^.]+$/, '')));
  const slug = (n) => n.trim().replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase().slice(0,96);
  const todo = maps.filter(m => !cached.has(slug(m)));
  console.log(`Already cached: ${cached.size}, total maps: ${maps.length}, to fetch: ${todo.length}`);
  let ok = 0, miss = 0;
  for (const m of todo) {
    const r = await fetch(`http://127.0.0.1:${port}/api/analyzer/map-image?name=${encodeURIComponent(m)}`).catch(e => ({status: 0}));
    if (r.status === 200) { ok++; console.log(`OK   ${m}`); }
    else { miss++; console.log(`MISS ${m} (HTTP ${r.status})`); }
    await new Promise(r => setTimeout(r, 60));
  }
  console.log(`---\nDONE: ${ok} fetched, ${miss} not found, ${cached.size + ok} total in cache`);
  server.close(); process.exit(0);
});
