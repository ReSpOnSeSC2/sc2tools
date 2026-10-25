/* Run from apps/web after the combined production build. Extends the real
 * game-story workspace fixture with synthetic benchmark responses. All
 * original tab/story/seek checks stay intact; screenshots remain in .cache. */
const fs = require('node:fs'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const metrics = Object.fromEntries(['macroScore','apm','spq','durationSec'].map(key => [key, { n: 50, median: 64, p25: 58, p75: 70 }]));
const table = { leagueId: 4, league: 'Diamond', matchup: 'ZvT', n: 100, updatedAt: '2026-10-24T00:00:00Z', metrics:
  Object.fromEntries(['macroScore','apm','spq','durationSec'].map(key => [key, { n: 100, deciles: [10,20,30,40,50,60,70,80,90] }])) };
const context = { matchup: 'ZvT', personal: { n: 50, limit: 50, metrics, build: 'Checked-in opener', expansionTimings: { Hatchery: 60 }, expansionSample: 8, expansionLimit: 25, expansionMinSample: 5 }, league: { table, percentiles: {} } };
let generator = fs.readFileSync('tests/manual/game-story-fixture.cjs', 'utf8')
  .replaceAll('game-story-fixture', 'game-benchmarks-workspace-fixture')
  .replaceAll('game-story-generator', 'game-benchmarks-workspace-generator')
  .replaceAll('3218', '3219');
const marker = "if(path?.endsWith('/map-playback/status'))";
const replacement = `if(path?.includes('/context?'))data=${JSON.stringify(context)};else ${marker}`;
const inject = `replaceOnce(${JSON.stringify(marker)},${JSON.stringify(replacement)});\n`;
generator = generator.replace("fs.mkdirSync('.tmp'", inject + "fs.mkdirSync('.tmp'");
fs.mkdirSync('.tmp', { recursive: true });
fs.writeFileSync('.tmp/game-benchmarks-workspace-generator.cjs', generator);
let runner = fs.readFileSync('tests/manual/game-story.cjs', 'utf8')
  .replace('tests/manual/game-story-fixture.cjs', '.tmp/game-benchmarks-workspace-generator.cjs')
  .replaceAll('game-story-fixture', 'game-benchmarks-workspace-fixture')
  .replaceAll('3218', '3219')
  .replaceAll('../../docs/handoff/screenshots/game-story', '../../.cache/game-benchmarks-workspace');
const assertion = "await expect(loss).toHaveAttribute('aria-selected', 'true'); checks++;";
if (runner.split(assertion).length !== 2) throw new Error('Story assertion boundary drifted');
runner = runner.replace(assertion, assertion + "\n        await expect(page.getByText('62nd percentile · Diamond ZvT')).toBeVisible(); checks++;\n        await expect(page.getByTestId('mechanics-panel').locator('..').getByRole('heading', {name:/Your usual and your league/})).toBeVisible(); checks++;");
fs.writeFileSync('.tmp/game-benchmarks-workspace-runner.cjs', runner);
execFileSync(process.execPath, [path.resolve('.tmp/game-benchmarks-workspace-runner.cjs')], { stdio: 'inherit' });
