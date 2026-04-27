const a = require('./analyzer.js');
const express = require('express');
const app = express();
app.use('/api/analyzer', a.router);
const server = app.listen(0, async () => {
  const port = server.address().port;
  const r = await fetch(`http://127.0.0.1:${port}/api/analyzer/games?limit=10000`).then(r => r.json());
  const counts = new Map();
  for (const g of r.games) counts.set(g.map, (counts.get(g.map) || 0) + 1);
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`UNIQUE MAPS IN DB: ${sorted.length}`);
  console.log(`TOP 25 BY GAME COUNT:`);
  for (const [m, n] of sorted.slice(0, 25)) console.log(`  ${String(n).padStart(5)}  ${m}`);
  console.log(`...and ${sorted.length - 25} more`);
  server.close(); process.exit(0);
});
