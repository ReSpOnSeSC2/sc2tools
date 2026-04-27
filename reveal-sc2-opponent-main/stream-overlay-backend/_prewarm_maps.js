const a = require('./analyzer.js');
const express = require('express');
const app = express();
app.use('/api/analyzer', a.router);
const server = app.listen(0, async () => {
  const port = server.address().port;
  const games = await fetch(`http://127.0.0.1:${port}/api/analyzer/games?limit=10000`).then(r => r.json());
  const maps = [...new Set(games.games.map(g => g.map).filter(Boolean))].sort();
  console.log(`Pre-warming cache for ${maps.length} unique maps...`);
  let ok = 0, miss = 0;
  for (const m of maps) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/analyzer/map-image?name=${encodeURIComponent(m)}`);
      if (r.status === 200) { ok++; process.stdout.write(`. `); }
      else                  { miss++; process.stdout.write(`x `); }
    } catch (e) { miss++; process.stdout.write(`! `); }
    // brief courtesy delay so we don't hammer Liquipedia
    await new Promise(r => setTimeout(r, 80));
  }
  console.log(`\nDONE: ${ok} fetched, ${miss} not found`);
  server.close(); process.exit(0);
});
